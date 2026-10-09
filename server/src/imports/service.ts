import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import { actorFrom, isUniqueViolation } from '../audit/chain.js';
import { clears, labelRank, type Label } from '../authz/labels.js';
import { rolesGranting } from '../authz/permissions.js';
import { effectivePermissions, type Principal } from '../authz/policy.js';
import { canonicalJson } from '../crypto/index.js';
import { json } from '../db/knex.js';
import type { ModelRow } from '../gateway/repo.js';
import { conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import type { JobContext, Scheduler } from '../platform/jobs.js';
import type { Services } from '../services.js';
import { ARTIFACT_REF } from '../training/trainer.js';
import { ADAPTERS, type AdapterContext, type RepositoryAdapter } from './adapters/index.js';
import { bundleAdapter, promotedModelFiles } from './adapters/bundle.js';
import { readAll } from './adapters/types.js';
import { CatalogStore } from './catalog.js';
import { DatasetImports } from './datasets.js';
import { ImportFetcher } from './fetcher.js';
import { contentProblem, DEFAULT_ALLOWED_LICENCES, formatOf, normaliseLicence, quantizationOf } from './formats.js';
import { RepositoryRegistry, type RepositoryRow } from './repositories.js';
import { ImportRefused, LIVE_STATES, RateLimited, REPO_TYPE_INFO, SourceError, type Check, type ImportOptions, type ImportRow, type ImportState, type LicenceStatus, type LogEntry, type ModelDetail, type PinnedFile, type RemoteFile } from './types.js';

/*
 * B-3803: model import. One request goes through the same checks the wizard shows, then a job pins, downloads,
 * verifies and registers:
 *
 * 1. Plan (nothing written): the files of the pinned revision with their digests, the variants, the gate, the licence
 *    as the source states it at that revision, the format and pickle checks, the destination tag and the size.
 * 2. Request: a refused plan is recorded on the queue as refused (no download, no model, no file); a licence outside
 *    the tenant's allow-list waits for an exception from the `legal-review` role (whoever requested cannot decide);
 *    an air-gapped instance queues the request for the weekly bundle.
 * 3. The `imports.model` job: re-reads the source at the pinned revision (a digest that changed under the same
 *    revision refuses the import), downloads each file in parts (an interrupted download resumes from the parts
 *    already stored), checks the first bytes (pickle refused again at staging) and the digest, then registers a
 *    draft model: an Ollama manifest as is (its digest is what the pools will report), a safetensors or GGUF repository
 *    through the GPU training worker's conversion, whose digest is pinned on the draft. The manifest (source,
 *    revision, digests, licence, label, attribution, requester) is signed and kept on the import.
 */

export interface PlanInput {
  repositoryId: string;
  item: string;
  revision?: string | null;
  variants?: string[];
  files?: string[];
  /** models (a draft tag) or classifiers (B-3806: a text-classification model as an imported classifier engine). */
  target?: 'models' | 'classifiers';
  label: Label;
  licence?: string | null;
  attribution?: string | null;
  tag?: string | null;
  quantization?: 'Q4_K_M' | 'Q5_K_M' | 'Q8_0' | 'F16' | null;
  poolId?: string | null;
  notes?: string | null;
  exception?: { reason?: string | null } | null;
  workspaceId?: string | null;
}

const NOT_SERVED = new Set(['text-classification', 'token-classification', 'zero-shot-classification', 'automatic-speech-recognition', 'audio-classification', 'image-classification', 'object-detection', 'image-segmentation', 'text-to-speech', 'text-to-image']);
const TAG = /^[a-zA-Z0-9][\w./:-]{0,199}$/;
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const n = (v: unknown): number | null => (v == null ? null : Number(v));
const artifactName = (name: string) => name.replace(/[^A-Za-z0-9._-]+/g, '__').replace(/^[^A-Za-z0-9]+/, 'f').slice(0, 200);

export const importFrom = (r: Record<string, unknown>): ImportRow => ({
  ...(r as unknown as ImportRow),
  files: json<PinnedFile[]>(r.files, []),
  options: json<ImportRow['options']>(r.options, {}),
  checks: json<Check[]>(r.checks, []),
  log: json<LogEntry[]>(r.log, []),
  manifest: json<Record<string, unknown> | null>(r.manifest, null),
  result: json<Record<string, unknown> | null>(r.result, null),
  rows_total: Number(r.rows_total ?? 0),
  sample_rows: n(r.sample_rows),
  progress: Number(r.progress ?? 0),
  size_bytes: Number(r.size_bytes ?? 0),
  stored_bytes: Number(r.stored_bytes ?? 0),
  created_at: Number(r.created_at),
  updated_at: Number(r.updated_at),
  started_at: n(r.started_at),
  finished_at: n(r.finished_at)
});

interface ExceptionRow {
  id: string;
  tenant_id: string;
  ref: string;
  import_id: string;
  licence: string;
  reason: string | null;
  state: 'pending' | 'granted' | 'refused' | 'withdrawn';
  requested_by: string;
  requested_at: number;
  decided_by: string | null;
  decided_at: number | null;
  decision_note: string | null;
}

const exceptionFrom = (r: Record<string, unknown>): ExceptionRow => ({ ...(r as unknown as ExceptionRow), requested_at: Number(r.requested_at), decided_at: n(r.decided_at) });

export interface Plan {
  repository: { id: string; name: string; type: string };
  item: string;
  name: string;
  revision: string | null;
  mode: 'direct' | 'bundle';
  source: 'live' | 'snapshot' | 'bundle';
  files: (RemoteFile & { selected: boolean })[];
  variants: { id: string; quantization: string | null; size: number | null; digest: string | null; selected: boolean }[];
  selected: RemoteFile[];
  variant: string | null;
  sizeBytes: number;
  gated: boolean;
  access: 'open' | 'granted' | 'gated';
  gate: { account: string | null; acceptedBy: string; acceptedAt: number } | null;
  licence: { id: string; source: string; allowed: boolean; recorded: boolean; needsException: boolean };
  label: Label;
  tag: string;
  conversion: { needed: boolean; quantization: string | null };
  family: string | null;
  parameters: string | null;
  classification: string | null;
  capabilities: string[];
  contextLength: number | null;
  manifestDigest: string | null;
  checks: Check[];
  blocked: boolean;
  waiting: boolean;
}

export class ImportService {
  readonly fetcher: ImportFetcher;
  readonly repositories: RepositoryRegistry;
  readonly catalog: CatalogStore;
  /** 1.7.0 (B-3804 to B-3806): dataset imports into Training, Classifiers and Knowledge. */
  readonly datasets: DatasetImports;

  constructor(private readonly s: () => Services, cfg: { IMPORT_ALLOWED_HOSTS: string; IMPORT_PROXY_URL?: string | undefined; IMPORT_TIMEOUT_MS: number }) {
    this.fetcher = new ImportFetcher({ allowedHosts: cfg.IMPORT_ALLOWED_HOSTS, proxyUrl: cfg.IMPORT_PROXY_URL ?? null, timeoutMs: cfg.IMPORT_TIMEOUT_MS });
    this.repositories = new RepositoryRegistry(s, this.fetcher);
    this.catalog = new CatalogStore(s);
    this.datasets = new DatasetImports(s, this);
  }

  // ---------- what the dataset imports share with the model imports (B-3804) ----------

  readonly rowFrom = importFrom;
  insertRef(tenantId: string, table: 'import_jobs' | 'import_exceptions', prefix: string, row: Record<string, unknown>): Promise<string> {
    return this.insertWithRef(tenantId, table, prefix, row);
  }
  patch(id: string, u: Partial<Record<keyof ImportRow, unknown>>): Promise<void> {
    return this.update(id, u);
  }
  log(id: string, e: LogEntry): Promise<void> {
    return this.appendLog(id, e);
  }
  notify(tenantId: string, userIds: string[], title: string, body: string, label: Label): Promise<void> {
    return this.notifyUsers(tenantId, userIds, title, body, label);
  }
  /** A licence outside the allow-list: the exception the legal-review role decides, and the notice to them. */
  async requestException(p: Principal, importId: string, ref: string, licence: string, reason: string | null, name: string, label: Label, traceId?: string | null): Promise<string> {
    const s = this.s();
    const t = Date.now();
    const excRef = await this.insertWithRef(p.tenantId, 'import_exceptions', 'EXC-', { id: ulid(), tenant_id: p.tenantId, import_id: importId, licence, reason, state: 'pending', requested_by: p.userId, requested_at: t });
    await this.appendLog(importId, { at: t, title: 'Licence exception requested', meta: `${excRef}: ${licence}`, tone: 'warn' });
    await this.audit(p, p.tenantId, 'import.exception.requested', { import: importId, ref, exception: excRef }, { licence, reason }, label, traceId);
    const reviewers = (await s.notifications.usersWithRoles(p.tenantId, rolesGranting('imports:review', p.tenantId).filter((x) => x !== 'system-admin'))).filter((u) => u !== p.userId);
    await this.notifyUsers(p.tenantId, reviewers, 'Licence exception to decide', `${p.displayName} asks to import ${name} under ${licence}, which is outside the tenant's allow-list (${excRef}, ${ref}).`, label, 'import.exception');
    return excRef;
  }

  private get db() {
    return this.s().db;
  }

  registerJobs(): void {
    const s = this.s();
    s.jobs.register('imports.harvest', (p, ctx) => this.repositories.harvestJob(String(p.repositoryId), ctx), { timeoutMs: 2 * 3_600_000 });
    s.jobs.register('imports.model', (p, ctx) => this.runModel(String(p.importId), ctx), { timeoutMs: 24 * 3_600_000 });
    s.jobs.register('imports.dataset', (p, ctx) => this.datasets.run(String(p.importId), ctx), { timeoutMs: 24 * 3_600_000 });
    s.jobs.register('imports.harvest-due', (p, ctx) => this.repositories.harvestDue(String(p.tenantId ?? ctx.job.tenant_id)));
    s.jobs.register('imports.bundle-match', (p, ctx) => this.bundleMatch(String(p.tenantId ?? ctx.job.tenant_id)));
  }

  schedule(scheduler: Scheduler, activeTenants: () => Promise<{ tenantId: string; payload?: Record<string, unknown> }[]>): void {
    const cfg = this.s().cfg;
    if (cfg.IMPORT_HARVEST_TICK_MINUTES > 0) scheduler.every('imports.harvest-due', cfg.IMPORT_HARVEST_TICK_MINUTES * 60_000, activeTenants);
    if (cfg.IMPORT_BUNDLE_POLL_MINUTES > 0) scheduler.every('imports.bundle-match', cfg.IMPORT_BUNDLE_POLL_MINUTES * 60_000, activeTenants);
  }

  private async audit(p: Principal | null, tenantId: string, action: string, target: Record<string, unknown>, detail: Record<string, unknown>, label?: Label, traceId?: string | null) {
    await this.s().audit.append({ tenantId, action, kind: p ? 'admin' : 'system', actor: p ? actorFrom(p) : { service: 'imports' }, target, detail, ...(label ? { label } : {}), traceId: traceId ?? null });
  }

  // ---------- licence policy, quota ----------

  async allowedLicences(tenantId: string): Promise<Set<string>> {
    const r = await this.db('import_settings').where({ tenant_id: tenantId }).first();
    return new Set(r ? json<string[]>(r.allowed_licences, []) : DEFAULT_ALLOWED_LICENCES);
  }

  async settings(tenantId: string) {
    const r = await this.db('import_settings').where({ tenant_id: tenantId }).first();
    return {
      allowedLicences: [...(await this.allowedLicences(tenantId))].sort(),
      defaultLicences: r == null,
      updatedBy: (r?.updated_by as string | null) ?? null,
      updatedAt: n(r?.updated_at),
      connectivity: this.s().cfg.IMPORT_CONNECTIVITY,
      viaProxy: this.fetcher.viaProxy,
      quota: await this.quota(tenantId)
    };
  }

  async setLicences(p: Principal, licences: string[], traceId?: string | null) {
    const list = [...new Set(licences.map((l) => normaliseLicence(l)).filter((l) => l !== 'unknown' && l !== 'other'))].sort();
    const before = [...(await this.allowedLicences(p.tenantId))].sort();
    const row = { allowed_licences: JSON.stringify(list), updated_by: p.userId, updated_at: Date.now() };
    const nUpd = await this.db('import_settings').where({ tenant_id: p.tenantId }).update(row);
    if (!nUpd) await this.db('import_settings').insert({ tenant_id: p.tenantId, ...row });
    await this.audit(p, p.tenantId, 'import.licences.updated', { tenant: p.tenantId }, { added: list.filter((l) => !before.includes(l)), removed: before.filter((l) => !list.includes(l)) }, undefined, traceId);
    return this.settings(p.tenantId);
  }

  /** The tenant's import storage: the dataset quota (500 GB unless a system admin sets another) and what is used. */
  async quota(tenantId: string) {
    const r = await this.db('import_quotas').where({ tenant_id: tenantId }).first();
    const max = r?.max_bytes != null ? Number(r.max_bytes) : this.s().cfg.IMPORT_DATASET_QUOTA_GB * 1_000_000_000;
    const used = (await this.db('import_jobs').where({ tenant_id: tenantId }).groupBy('kind').select('kind').sum({ bytes: 'stored_bytes' })) as { kind: string; bytes: unknown }[];
    const by = (k: string) => Number(used.find((u) => u.kind === k)?.bytes ?? 0);
    return { maxBytes: max, custom: r?.max_bytes != null, usedBytes: { datasets: by('dataset'), models: by('model'), total: by('dataset') + by('model') }, appliesTo: 'datasets', updatedAt: n(r?.updated_at) };
  }

  async setQuota(p: Principal, tenantId: string, maxBytes: number | null, traceId?: string | null) {
    const before = await this.quota(tenantId);
    const row = { max_bytes: maxBytes, updated_by: p.userId, updated_at: Date.now() };
    const nUpd = await this.db('import_quotas').where({ tenant_id: tenantId }).update(row);
    if (!nUpd) await this.db('import_quotas').insert({ tenant_id: tenantId, ...row });
    const e = { action: 'import.quota.updated', kind: 'admin' as const, actor: actorFrom(p), target: { tenant: tenantId }, detail: { before: before.custom ? before.maxBytes : null, after: maxBytes }, traceId: traceId ?? null };
    await Promise.all([this.s().audit.append({ tenantId, ...e }), ...(tenantId !== p.tenantId ? [this.s().audit.append({ tenantId: p.tenantId, ...e })] : [])]);
    return this.quota(tenantId);
  }

  /** Dataset imports (B-3804) call this before fetching: refuses what would take the tenant over its import quota. */
  async admitDataset(tenantId: string, bytes: number): Promise<void> {
    const q = await this.quota(tenantId);
    if (q.usedBytes.datasets + bytes > q.maxBytes) {
      throw new HttpProblem(413, 'Import quota exceeded', `This tenant has ${Math.max(0, q.maxBytes - q.usedBytes.datasets).toLocaleString('en-US')} of ${q.maxBytes.toLocaleString('en-US')} bytes of dataset import quota left; this import needs ${bytes.toLocaleString('en-US')}. Import a sample or a smaller configuration, or ask a system admin to raise the quota.`, {
        extensions: { limit: 'import_bytes', used: q.usedBytes.datasets, max: q.maxBytes, incoming: bytes }
      });
    }
  }

  // ---------- inspect, gate, plan ----------

  private modeFor(r: RepositoryRow): 'direct' | 'bundle' {
    return this.s().cfg.IMPORT_CONNECTIVITY === 'bundle' && r.type !== 'bundle' ? 'bundle' : 'direct';
  }

  private async modelRepo(p: Principal, repositoryId: string): Promise<RepositoryRow> {
    const r = await this.repositories.active(p.tenantId, repositoryId);
    if (!REPO_TYPE_INFO[r.type].modelImport || !r.kinds.includes('model')) throw conflict(`${r.name} does not import models (dataset import comes with B-3804).`);
    return r;
  }

  /** The select step: one model as the source states it now (or the snapshot, on an air-gapped instance). */
  async inspect(p: Principal, repositoryId: string, itemId: string, revision?: string | null): Promise<ModelDetail & { source: 'live' | 'snapshot' | 'bundle'; gate: Plan['gate'] }> {
    const r = await this.modelRepo(p, repositoryId);
    const gate = await this.gateOf(r, itemId);
    if (this.modeFor(r) === 'bundle') {
      const row = await this.catalog.item(r, 'model', itemId);
      if (!row) throw notFound('Item in the snapshot');
      const variants = Array.isArray(row.data.variants) ? (row.data.variants as { tag: string; digest: string; size: number; quantization: string | null }[]) : [];
      return { itemId, name: row.name, revision: revision ?? null as unknown as string, files: [], variants: variants.map((v) => ({ id: v.tag, quantization: v.quantization, size: v.size, files: [], digest: v.digest })), gated: row.gated, access: row.gated ? (gate ? 'granted' : 'gated') : 'open', licence: row.licence, licenceSource: 'the catalogue snapshot (staging reads it again from the fetched files)', classification: row.classification, family: null, parameters: null, capabilities: [], contextLength: null, data: row.data, source: 'snapshot', gate };
    }
    if (this.repositories.backingOff(r)) throw new HttpProblem(503, 'Source rate limited', `${r.name} is rate limiting the staging proxy until ${new Date(r.backoff_until!).toISOString()}. Requests queue with backoff; try the select step again then.`, { headers: { 'Retry-After': String(Math.ceil((r.backoff_until! - Date.now()) / 1000)) }, extensions: { backoffUntil: r.backoff_until } });
    try {
      const d = await ADAPTERS[r.type].inspect!(this.repositories.context(r), itemId, revision);
      return { ...d, access: d.gated && d.access !== 'granted' && gate ? 'gated' : d.access, source: r.type === 'bundle' ? 'bundle' : 'live', gate };
    } catch (err) {
      throw await this.sourceProblem(r, err);
    }
  }

  private async sourceProblem(r: RepositoryRow, err: unknown): Promise<HttpProblem> {
    if (err instanceof HttpProblem) return err;
    await this.repositories.markError(r, err);
    if (err instanceof RateLimited) return new HttpProblem(503, 'Source rate limited', `${err.message} The repository backs off; try again later.`);
    if (err instanceof SourceError) return new HttpProblem(err.status === 404 ? 404 : 502, err.status === 404 ? 'Not found' : 'Source error', err.message);
    return err as HttpProblem;
  }

  private async gateOf(r: RepositoryRow, itemId: string): Promise<Plan['gate']> {
    const g = await this.db('import_gates').where({ repository_id: r.id, item_id: itemId }).first();
    return g ? { account: (g.account as string | null) ?? null, acceptedBy: String(g.accepted_by), acceptedAt: Number(g.accepted_at) } : null;
  }

  /** Accepts a gated repository's licence with the repository's recorded token, and records who did and when. */
  async acceptGate(p: Principal, repositoryId: string, itemId: string, traceId?: string | null) {
    const r = await this.modelRepo(p, repositoryId);
    const adapter = ADAPTERS[r.type];
    if (!adapter.acceptGate) throw conflict(`${REPO_TYPE_INFO[r.type].name} has no gates.`);
    if (this.modeFor(r) === 'bundle') throw conflict('This instance is air-gapped; staging accepts gates with its own token.');
    let account: string | null;
    let detail: ModelDetail;
    try {
      ({ account } = await adapter.acceptGate(this.repositories.context(r), itemId));
      detail = await adapter.inspect!(this.repositories.context(r), itemId, null);
    } catch (err) {
      throw await this.sourceProblem(r, err);
    }
    if (detail.access !== 'granted' && detail.access !== 'open') {
      await this.audit(p, p.tenantId, 'import.gate.requested', { repository: r.id, item: itemId }, { account, credential: r.credential_ref });
      throw new HttpProblem(409, 'Gate pending', `The access request for ${itemId} was sent with the recorded token (account ${account ?? 'unknown'}), but the files are not readable yet: the publisher approves it by hand. Try again later.`, { extensions: { access: detail.access } });
    }
    const t = Date.now();
    await this.db('import_gates').where({ repository_id: r.id, item_id: itemId }).delete();
    await this.db('import_gates').insert({ id: ulid(), tenant_id: p.tenantId, repository_id: r.id, item_id: itemId, account, credential_ref: r.credential_ref, accepted_by: p.userId, accepted_at: t });
    await this.audit(p, p.tenantId, 'import.gate.accepted', { repository: r.id, item: itemId }, { account, credential: r.credential_ref, revision: detail.revision }, undefined, traceId);
    return { item: itemId, access: 'granted', account, acceptedBy: p.userId, acceptedAt: t };
  }

  private defaultTag(r: RepositoryRow, d: Pick<ModelDetail, 'itemId' | 'data'>, variant: string | null, quant: string | null): string {
    if (r.type === 'ollama') {
      const u = new URL(r.base_url);
      const name = d.itemId.startsWith('library/') ? d.itemId.slice(8) : d.itemId;
      return `${u.hostname === 'registry.ollama.ai' ? '' : `${u.host}/${d.itemId.includes('/') ? '' : 'library/'}`}${name}:${variant ?? 'latest'}`;
    }
    const base = (d.itemId.split('/').pop() ?? d.itemId).toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '') || 'model';
    return `${base}:${(quant ?? 'q4_k_m').toLowerCase()}`;
  }

  /** The review step: every check, the files that would be fetched, the tag; nothing is written. */
  async plan(p: Principal, input: PlanInput): Promise<Plan> {
    const s = this.s();
    const r = await this.modelRepo(p, input.repositoryId);
    const mode = this.modeFor(r);
    const d = await this.inspect(p, r.id, input.item, input.revision ?? null);
    const checks: Check[] = [];
    // ---- selection
    const isOllama = r.type === 'ollama' || d.files.some((f) => f.format === 'manifest');
    let selected: RemoteFile[] = [];
    let variant: string | null = null;
    if (mode === 'bundle') {
      variant = r.type === 'ollama' ? (input.revision ?? input.variants?.[0] ?? d.variants[0]?.id ?? 'latest') : (input.variants?.[0] ?? null);
    } else if (isOllama) {
      variant = r.type === 'ollama' ? String(d.data.tag ?? input.revision ?? 'latest') : null;
      selected = d.files;
    } else if (input.variants?.length) {
      selected = d.files.filter((f) => input.variants!.includes(f.name));
      variant = input.variants[0] ?? null;
      if (selected.length !== input.variants.length) checks.push({ name: 'Format', result: 'refused', detail: 'A selected variant is not in the repository at this revision.' });
    } else if (input.files?.length) {
      selected = d.files.filter((f) => input.files!.includes(f.name));
      if (selected.length !== input.files.length) checks.push({ name: 'Format', result: 'refused', detail: 'A selected file is not in the repository at this revision.' });
    } else {
      const st = d.files.filter((f) => f.format === 'safetensors');
      const gg = d.files.filter((f) => f.format === 'gguf');
      if (st.length) selected = [...st, ...d.files.filter((f) => f.format === 'metadata')];
      else if (gg.length) {
        const pick = gg.find((f) => /q4_k_m/i.test(f.name)) ?? gg[0]!;
        selected = [pick];
        variant = pick.name;
      } else selected = d.files.filter((f) => f.format === 'pickle' || f.format === 'onnx');
    }
    const weights = selected.filter((f) => f.format === 'gguf' || f.format === 'safetensors');
    const gguf = selected.filter((f) => f.format === 'gguf' && !/projector|adapter/.test(f.mediaType ?? ''));
    // ---- format
    if (!checks.length && mode !== 'bundle') {
      const pickles = selected.filter((f) => f.format === 'pickle');
      const others = selected.filter((f) => f.format === 'onnx' || f.format === 'other');
      const hasSafe = d.files.some((f) => f.format === 'gguf' || f.format === 'safetensors');
      if (!hasSafe && d.files.some((f) => f.format === 'pickle')) checks.push({ name: 'Format', result: 'refused', detail: `Only pickle checkpoints are published (${d.files.filter((f) => f.format === 'pickle').map((f) => f.name).slice(0, 3).join(', ')}). Only GGUF and safetensors cross the import path; nothing is written. Ask the publisher for safetensors, or pick a mirror that has them.` });
      else if (pickles.length) checks.push({ name: 'Format', result: 'refused', detail: `${pickles.map((f) => f.name).slice(0, 3).join(', ')} ${pickles.length > 1 ? 'are pickle checkpoints' : 'is a pickle checkpoint'}. Only GGUF and safetensors cross the import path; nothing is written.` });
      else if (others.length) checks.push({ name: 'Format', result: 'refused', detail: `${others.map((f) => f.name).slice(0, 3).join(', ')}: only GGUF and safetensors weights are imported.` });
      else if (!weights.length) checks.push({ name: 'Format', result: 'refused', detail: 'No GGUF or safetensors weights are selected.' });
      else if (!isOllama && gguf.length > 1) checks.push({ name: 'Format', result: 'refused', detail: 'Select one GGUF variant per import: each registers its own draft tag.' });
      else if (!isOllama && gguf.length && weights.some((f) => f.format === 'safetensors')) checks.push({ name: 'Format', result: 'refused', detail: 'Select either a GGUF variant or the safetensors files, not both.' });
      else checks.push({ name: 'Format', result: 'passed', detail: isOllama ? `GGUF layers of ${d.name}, manifest ${String(d.revision).slice(0, 19)}` : gguf.length ? `GGUF variant ${gguf[0]!.name}` : `${weights.length} safetensors file${weights.length > 1 ? 's' : ''}, converted to GGUF on the training pool` });
    } else if (mode === 'bundle') checks.push({ name: 'Format', result: 'info', detail: 'Checked at staging (pickle refused before signing) and again here, file by file, when the bundle arrives.' });
    // ---- licence
    const allowed = await this.allowedLicences(p.tenantId);
    const sourceLicence = normaliseLicence(d.licence);
    const unknown = sourceLicence === 'unknown' || sourceLicence === 'other';
    const recorded = unknown && !!input.licence;
    const licence = recorded ? normaliseLicence(input.licence) : sourceLicence;
    const licenceAllowed = allowed.has(licence);
    const needsException = !licenceAllowed && !(unknown && !input.licence);
    if (unknown && !input.licence) checks.push({ name: 'Licence', result: 'waiting', detail: `The source states no recognised licence (${d.licenceSource}). Record it; anything outside the tenant's allow-list waits for legal review.` });
    else if (licenceAllowed) checks.push({ name: 'Licence', result: 'passed', detail: `${licence}, read from ${recorded ? 'the requester (recorded by hand)' : d.licenceSource}; on the tenant's allow-list.` });
    else checks.push({ name: 'Licence', result: 'waiting', detail: `${licence} is outside the tenant's allow-list. The import waits in the queue for a licence exception decided by the legal-review role.` });
    // ---- gate
    if (d.gated && d.access !== 'granted') checks.push({ name: 'Access', result: 'waiting', detail: `The repository is gated. Accept the licence gate on ${r.host} with the recorded token before files can be fetched.` });
    else if (d.gated) checks.push({ name: 'Access', result: 'passed', detail: `Gate accepted${d.gate ? ` by ${d.gate.account ?? 'the recorded token'} on ${new Date(d.gate.acceptedAt).toISOString().slice(0, 10)}` : ' with the recorded token'}.` });
    else checks.push({ name: 'Access', result: 'passed', detail: 'Open repository.' });
    // ---- serving path and conversion
    const conversion = { needed: input.target !== 'classifiers' && !isOllama && mode === 'direct' && weights.length > 0, quantization: !isOllama && gguf.length ? 'as-is' : !isOllama ? (input.quantization ?? 'Q4_K_M') : null };
    if (input.target === 'classifiers') checks.push({ name: 'Serving path', result: d.classification && /classification/.test(d.classification) ? 'passed' : 'warning', detail: `Registers in Classifiers as an imported engine served by the classifier worker (${d.classification ?? 'classification unknown'}); nothing is placed on a pool.` });
    else if (d.classification && NOT_SERVED.has(d.classification)) checks.push({ name: 'Serving path', result: 'refused', detail: `${d.classification} models are not served by the gateway. Classifier engines and media weights are imported with B-3806; only models Ollama serves register as draft tags now.` });
    else checks.push({ name: 'Serving path', result: 'passed', detail: 'Registers in the model catalogue as a draft tag; evaluation, approval and placement follow as for any model.' });
    if (conversion.needed && !s.trainer.available) checks.push({ name: 'Conversion', result: 'refused', detail: `${s.trainer.reason ?? 'No training worker is configured.'} GGUF conversion and packaging run on the training pool.` });
    else if (conversion.needed) checks.push({ name: 'Conversion', result: 'info', detail: conversion.quantization === 'as-is' ? 'The published GGUF is packaged on the training pool and pushed where the pools pull from.' : `Converted to GGUF ${conversion.quantization} on the training pool (llama.cpp convert and quantize).` });
    // ---- destination
    const quant = conversion.quantization === 'as-is' ? quantizationOf(gguf[0]?.name ?? '') : conversion.quantization;
    const tag = (input.tag ?? this.defaultTag(r, d, variant, quant)).trim();
    if (!TAG.test(tag)) checks.push({ name: 'Destination', result: 'refused', detail: `${tag.slice(0, 80)} is not an Ollama tag (letters, digits, . _ / : -).` });
    else if (input.target !== 'classifiers' && (await s.gateway.repo.modelByName(tag))) checks.push({ name: 'Destination', result: 'refused', detail: `${tag} is already in the model catalogue. Choose another tag.` });
    else if (!clears(p.clearance, input.label)) checks.push({ name: 'Destination', result: 'refused', detail: `Your clearance does not reach ${input.label}.` });
    else if (input.poolId) {
      const pool = await s.gateway.repo.pool(input.poolId);
      if (!pool) checks.push({ name: 'Destination', result: 'refused', detail: 'The pool does not exist.' });
      else if (labelRank(input.label) > labelRank(pool.label_ceiling)) checks.push({ name: 'Destination', result: 'refused', detail: `${pool.name}'s ceiling is ${pool.label_ceiling}, below ${input.label}.` });
      else checks.push({ name: 'Destination', result: 'passed', detail: `Draft tag ${tag}, pulled onto ${pool.name} once registered.` });
    } else checks.push({ name: 'Destination', result: 'passed', detail: `Draft tag ${tag}.` });
    // ---- size
    const size = selected.reduce((a, f) => a + (f.size ?? 0), 0);
    if (size > s.cfg.IMPORT_MAX_BYTES) checks.push({ name: 'Size', result: 'refused', detail: `${size.toLocaleString('en-US')} bytes selected; one import fetches at most ${s.cfg.IMPORT_MAX_BYTES.toLocaleString('en-US')} (IMPORT_MAX_BYTES).` });
    else checks.push({ name: 'Size', result: 'info', detail: `${size.toLocaleString('en-US')} bytes to fetch; model imports are metered beside the tenant's dataset quota.` });
    // ---- connectivity
    if (mode === 'bundle') checks.push({ name: 'Connectivity', result: 'info', detail: 'This instance is air-gapped. The request joins the weekly bundle: staging fetches, scans and signs, and the import continues here after the diode transfer.' });
    else if (r.type === 'bundle') checks.push({ name: 'Connectivity', result: 'info', detail: 'Read from promoted signed bundles; nothing goes over the network.' });
    else if (r.status === 'rate limited') checks.push({ name: 'Connectivity', result: 'warning', detail: `${r.name} was rate limiting the staging proxy; downloads queue with backoff.` });
    else checks.push({ name: 'Connectivity', result: 'passed', detail: `Through ${this.fetcher.viaProxy ? 'the staging proxy' : 'the import egress'}, allow-listed hosts only (${[r.host, ...r.extra_hosts].slice(0, 4).join(', ')}).` });
    return {
      repository: { id: r.id, name: r.name, type: r.type },
      item: d.itemId,
      name: d.name,
      revision: d.revision ?? null,
      mode,
      source: d.source,
      files: d.files.map((f) => ({ ...f, selected: selected.includes(f) })),
      variants: d.variants.map((v) => ({ id: v.id, quantization: v.quantization, size: v.size, digest: v.digest, selected: v.id === variant })),
      selected,
      variant,
      sizeBytes: size,
      gated: d.gated,
      access: d.access,
      gate: d.gate,
      licence: { id: licence, source: recorded ? 'recorded by the requester' : d.licenceSource, allowed: licenceAllowed, recorded, needsException },
      label: input.label,
      tag,
      conversion,
      family: d.family,
      parameters: d.parameters,
      classification: d.classification,
      capabilities: d.capabilities,
      contextLength: d.contextLength,
      manifestDigest: isOllama && mode === 'direct' ? d.revision : (d.variants.find((v) => v.id === variant)?.digest ?? null),
      checks,
      blocked: checks.some((c) => c.result === 'refused'),
      waiting: checks.some((c) => c.result === 'waiting')
    };
  }

  // ---------- requests ----------

  private async nextRef(tenantId: string, table: 'import_jobs' | 'import_exceptions', prefix: string): Promise<string> {
    const [{ c }] = (await this.db(table).where({ tenant_id: tenantId }).andWhere('ref', 'like', `${prefix}%`).count({ c: '*' })) as [{ c: number | string }];
    return `${prefix}${Number(c) + 1}`;
  }

  private async insertWithRef(tenantId: string, table: 'import_jobs' | 'import_exceptions', prefix: string, row: Record<string, unknown>): Promise<string> {
    for (let i = 0; i < 6; i++) {
      const ref = await this.nextRef(tenantId, table, prefix);
      try {
        await this.db(table).insert({ ...row, ref: i ? `${ref}-${i}` : ref });
        return i ? `${ref}-${i}` : ref;
      } catch (err) {
        if (!isUniqueViolation(err) || i === 5) throw err;
      }
    }
    throw new Error('unreachable');
  }

  private notifyUsers = async (tenantId: string, userIds: string[], title: string, body: string, label: Label, kind = 'import') => {
    const ids = [...new Set(userIds)].filter(Boolean);
    if (ids.length) await this.s().notifications.notify({ tenantId, userIds: ids, kind, title, body, route: '#/import?tab=imports', label });
  };

  async request(p: Principal, input: PlanInput, traceId?: string | null) {
    const s = this.s();
    const target = input.target ?? 'models';
    if (target === 'models' && !effectivePermissions(p).has('models:manage')) throw forbidden('Importing a model into the catalogue needs models:manage as well as imports:run.', { step: 'role', action: 'models:manage' });
    if (target === 'classifiers' && !effectivePermissions(p).has('classifiers:manage')) throw forbidden('Importing a classifier engine needs classifiers:manage as well as imports:run.', { step: 'role', action: 'classifiers:manage' });
    if (!clears(p.clearance, input.label)) throw forbidden('You cannot import for data above your clearance.', { step: 'clearance' });
    const plan = await this.plan(p, input);
    const r = await this.repositories.get(p.tenantId, input.repositoryId);
    const t = Date.now();
    const base = {
      id: ulid(),
      tenant_id: p.tenantId,
      workspace_id: input.workspaceId ?? p.workspaceId ?? null,
      kind: 'model',
      repository_id: r.id,
      item_id: plan.item.slice(0, 300),
      item_name: plan.name.slice(0, 400),
      revision: plan.revision,
      target,
      mode: plan.mode,
      progress: 0,
      checks: JSON.stringify(plan.checks),
      licence: plan.licence.id,
      label: input.label,
      attribution: input.attribution ?? null,
      size_bytes: plan.sizeBytes,
      stored_bytes: 0,
      requested_by: p.userId,
      created_at: t,
      updated_at: t
    };
    const files: PinnedFile[] = plan.selected.map((f) => ({ name: f.name, size: f.size, pin: f.pin, format: f.format, mediaType: f.mediaType ?? null, done: 0, parts: [], sha256: null, blob: null, state: 'pending' }));
    const options: ImportRow['options'] = { tag: plan.tag, quantization: plan.conversion.quantization ?? undefined, poolId: input.poolId ?? null, family: plan.family, capabilities: plan.capabilities, notes: input.notes ?? null, variant: plan.variant, manifestDigest: plan.manifestDigest };
    if (plan.blocked) {
      const refused = plan.checks.filter((c) => c.result === 'refused');
      const ref = await this.insertWithRef(p.tenantId, 'import_jobs', `IMP-${new Date(t).getUTCFullYear()}-`, { ...base, state: 'refused', stage: null, note: refused[0]!.detail.slice(0, 500), files: '[]', options: JSON.stringify(options), log: JSON.stringify([{ at: t, title: 'Refused', meta: refused.map((c) => `${c.name}: ${c.detail}`).join(' ').slice(0, 1000), tone: 'danger' }]), manifest: null, licence_status: 'allowed', finished_at: t, error: refused.map((c) => c.detail).join(' ').slice(0, 1000) });
      await this.audit(p, p.tenantId, 'import.refused', { import: base.id, ref, repository: r.id, item: plan.item }, { checks: refused, revision: plan.revision }, input.label, traceId);
      throw new HttpProblem(422, 'Import refused', refused.map((c) => c.detail).join(' '), { extensions: { import: await this.view(p.tenantId, (await this.row(p.tenantId, base.id))!), checks: plan.checks, reason: refused.map((c) => c.name.toLowerCase()) } });
    }
    if (plan.access === 'gated' && plan.mode === 'direct') throw new HttpProblem(409, 'Gate not accepted', `${plan.item} is gated. Accept the gate with the recorded token first (POST /api/imports/repositories/${r.id}/gate).`, { extensions: { reason: 'gate' } });
    const unknownLicence = plan.checks.some((c) => c.name === 'Licence' && c.result === 'waiting') && !plan.licence.needsException && !plan.licence.allowed;
    if (unknownLicence) throw new HttpProblem(409, 'Licence not recorded', 'The source states no recognised licence. Record it (`licence`) to continue; outside the allow-list it then waits for legal review.', { extensions: { reason: 'licence-unknown' } });
    if (plan.licence.needsException && !input.exception) throw new HttpProblem(409, 'Licence exception required', `${plan.licence.id} is outside the tenant's allow-list. Request an exception (\`exception: {reason}\`); the import then waits for the legal-review role to decide.`, { extensions: { reason: 'licence-exception-required', licence: plan.licence.id } });
    const state: ImportState = plan.licence.needsException ? 'waiting on licence' : plan.mode === 'bundle' ? 'queued for bundle' : 'queued';
    const licenceStatus: LicenceStatus = plan.licence.needsException ? 'exception pending' : 'allowed';
    const log: LogEntry[] = [{ at: t, title: 'Request accepted', meta: `${plan.licence.id} read from ${plan.licence.source}${plan.revision ? `; revision ${plan.revision.slice(0, 19)} pinned` : ''}`, tone: 'ok' }];
    if (plan.mode === 'bundle') log.push({ at: t, title: 'Queued for the bundle', meta: 'staging fetches, scans and signs; the import continues here after the transfer', tone: '' });
    const ref = await this.insertWithRef(p.tenantId, 'import_jobs', `IMP-${new Date(t).getUTCFullYear()}-`, { ...base, state, stage: null, note: state === 'waiting on licence' ? `${plan.licence.id} is outside the tenant policy; waiting on legal review` : null, files: JSON.stringify(files), options: JSON.stringify(options), log: JSON.stringify(log), manifest: null, licence_status: licenceStatus, finished_at: null, error: null });
    await this.audit(p, p.tenantId, 'import.requested', { import: base.id, ref, repository: r.id, item: plan.item }, { revision: plan.revision, licence: plan.licence, label: input.label, tag: plan.tag, mode: plan.mode, files: files.map((f) => ({ name: f.name, pin: f.pin })), state }, input.label, traceId);
    if (state === 'waiting on licence') {
      const excRef = await this.insertWithRef(p.tenantId, 'import_exceptions', 'EXC-', { id: ulid(), tenant_id: p.tenantId, import_id: base.id, licence: plan.licence.id, reason: input.exception?.reason ?? null, state: 'pending', requested_by: p.userId, requested_at: t, decided_by: null, decided_at: null, decision_note: null });
      await this.appendLog(base.id, { at: t, title: 'Licence exception requested', meta: `${excRef}: ${plan.licence.id}`, tone: 'warn' });
      await this.audit(p, p.tenantId, 'import.exception.requested', { import: base.id, ref, exception: excRef }, { licence: plan.licence.id, reason: input.exception?.reason ?? null }, input.label, traceId);
      const reviewers = (await s.notifications.usersWithRoles(p.tenantId, rolesGranting('imports:review', p.tenantId).filter((x) => x !== 'system-admin'))).filter((u) => u !== p.userId);
      await this.notifyUsers(p.tenantId, reviewers, 'Licence exception to decide', `${p.displayName} asks to import ${plan.name} under ${plan.licence.id}, which is outside the tenant's allow-list (${excRef}, ${ref}).`, input.label, 'import.exception');
    } else if (state === 'queued') await this.enqueue(p.tenantId, base.id, p.userId);
    return this.view(p.tenantId, (await this.row(p.tenantId, base.id))!);
  }

  private async enqueue(tenantId: string, importId: string, by: string | null, runAt?: number): Promise<string> {
    const job = await this.s().jobs.enqueue({ tenantId, type: 'imports.model', payload: { importId }, createdBy: by, maxAttempts: 1, ...(runAt ? { runAt } : {}) });
    await this.db('import_jobs').where({ id: importId }).update({ job_id: job.id, updated_at: Date.now() });
    return job.id;
  }

  private async appendLog(id: string, e: LogEntry): Promise<void> {
    const r = await this.db('import_jobs').where({ id }).first('log');
    const log = json<LogEntry[]>(r?.log, []);
    log.push({ ...e, meta: e.meta.slice(0, 1000) });
    await this.db('import_jobs').where({ id }).update({ log: JSON.stringify(log.slice(-200)), updated_at: Date.now() });
  }

  private async update(id: string, u: Partial<Record<keyof ImportRow, unknown>>): Promise<void> {
    const out: Record<string, unknown> = { updated_at: Date.now() };
    for (const [k, v] of Object.entries(u)) out[k] = ['files', 'options', 'checks', 'log', 'manifest'].includes(k) ? (v == null ? null : JSON.stringify(v)) : v;
    await this.db('import_jobs').where({ id }).update(out);
  }

  async row(tenantId: string, id: string): Promise<ImportRow | null> {
    const r = await this.db('import_jobs').where({ tenant_id: tenantId, id }).first();
    return r ? importFrom(r) : null;
  }

  async view(tenantId: string, r: ImportRow) {
    const [repo, exc, user, model] = await Promise.all([
      this.db('import_repositories').where({ id: r.repository_id }).first('id', 'name', 'type'),
      this.db('import_exceptions').where({ import_id: r.id }).orderBy('requested_at', 'desc').first(),
      this.db('users').where({ id: r.requested_by }).first('display_name'),
      r.model_id ? this.s().gateway.repo.model(r.model_id) : Promise.resolve(undefined)
    ]);
    void tenantId;
    return {
      id: r.id,
      ref: r.ref,
      kind: r.kind,
      repository: repo ? { id: String(repo.id), name: String(repo.name), type: String(repo.type) } : { id: r.repository_id, name: null, type: null },
      item: r.item_id,
      itemName: r.item_name,
      revision: r.revision,
      target: r.target,
      mode: r.mode,
      state: r.state,
      stage: r.stage,
      progress: r.progress,
      note: r.note,
      files: r.files.map((f) => ({ name: f.name, size: f.size, pin: f.pin, format: f.format, done: f.done, sha256: f.sha256, state: f.state })),
      options: r.options,
      checks: r.checks,
      log: r.log,
      manifest: r.manifest,
      licence: r.licence,
      licenceStatus: r.licence_status,
      exception: exc ? { id: String(exc.id), ref: String(exc.ref), state: String(exc.state), decidedBy: (exc.decided_by as string | null) ?? null, decisionNote: (exc.decision_note as string | null) ?? null } : null,
      label: r.label,
      attribution: r.attribution,
      sizeBytes: r.size_bytes,
      storedBytes: r.stored_bytes,
      jobId: r.job_id,
      model: model ? { id: model.id, name: model.name, state: model.state, expectedDigest: model.expected_digest } : null,
      // B-3804: what a dataset import made, and where it went.
      result: r.result,
      rowsTotal: r.rows_total,
      sampleRows: r.sample_rows,
      datasetId: r.dataset_id,
      kbId: r.kb_id,
      sourceId: r.source_id,
      classifierId: r.classifier_id,
      evalSet: r.eval_set,
      error: r.error,
      requestedBy: r.requested_by,
      requestedByName: (user?.display_name as string | undefined) ?? null,
      createdAt: r.created_at,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      updatedAt: r.updated_at
    };
  }

  async list(p: Principal, f: { state?: string; kind?: string; q?: string; limit: number; offset: number }) {
    const q = this.db('import_jobs').where({ tenant_id: p.tenantId });
    if (f.state) q.andWhere({ state: f.state });
    if (f.kind) q.andWhere({ kind: f.kind });
    if (f.q) q.andWhereRaw('(lower(item_id) like ? or lower(ref) like ?)', [`%${f.q.toLowerCase()}%`, `%${f.q.toLowerCase()}%`]);
    const rows = ((await q.orderBy('created_at', 'desc').limit(500)) as Record<string, unknown>[]).map(importFrom).filter((r) => clears(p.clearance, r.label));
    const counts = { total: rows.length, running: rows.filter((r) => r.state === 'running').length, waiting: rows.filter((r) => r.state === 'waiting on licence' || r.state === 'queued for bundle').length, queued: rows.filter((r) => r.state === 'queued').length };
    return { counts, imports: await Promise.all(rows.slice(f.offset, f.offset + f.limit).map((r) => this.view(p.tenantId, r))) };
  }

  async get(p: Principal, id: string) {
    const r = await this.row(p.tenantId, id);
    if (!r || !clears(p.clearance, r.label)) throw notFound('Import');
    return r;
  }

  async cancel(p: Principal, id: string, traceId?: string | null) {
    const r = await this.get(p, id);
    if (!(LIVE_STATES as readonly string[]).includes(r.state)) throw conflict(`${r.ref} is ${r.state}; only a queued, waiting or running import is cancelled.`);
    const t = Date.now();
    await this.update(r.id, { state: 'cancelled', stage: null, note: `Cancelled by ${p.displayName}`, finished_at: t });
    await this.db('import_exceptions').where({ import_id: r.id, state: 'pending' }).update({ state: 'withdrawn', decided_at: t });
    await this.appendLog(r.id, { at: t, title: 'Cancelled', meta: p.displayName, tone: 'warn' });
    if (r.job_id) await this.s().jobs.cancel(p.tenantId, r.job_id).catch(() => undefined);
    if (r.state !== 'running') await this.discardParts(r);
    await this.audit(p, p.tenantId, 'import.cancelled', { import: r.id, ref: r.ref }, { from: r.state }, r.label, traceId);
    return this.view(p.tenantId, (await this.row(p.tenantId, r.id))!);
  }

  async retry(p: Principal, id: string, traceId?: string | null) {
    const r = await this.get(p, id);
    if (r.state === 'refused') throw conflict(`${r.ref} was refused by a check; retrying changes nothing. Choose another source or selection.`);
    if (r.state !== 'failed' && r.state !== 'cancelled') throw conflict(`${r.ref} is ${r.state}; only a failed or cancelled import is retried.`);
    if (r.licence_status === 'exception refused') throw conflict(`${r.ref}'s licence exception was refused.`);
    const state: ImportState = r.licence_status === 'exception pending' ? 'waiting on licence' : r.mode === 'bundle' && !r.options.manifestDigest && !r.files.length ? 'queued for bundle' : 'queued';
    await this.update(r.id, { state, error: null, note: 'Retried; downloads resume from the parts already stored', finished_at: null });
    await this.appendLog(r.id, { at: Date.now(), title: 'Retried', meta: p.displayName, tone: '' });
    if (state === 'queued') await (r.kind === 'dataset' ? this.datasets.enqueue(p.tenantId, r.id, p.userId) : this.enqueue(p.tenantId, r.id, p.userId));
    await this.audit(p, p.tenantId, 'import.retried', { import: r.id, ref: r.ref }, { from: r.state }, r.label, traceId);
    return this.view(p.tenantId, (await this.row(p.tenantId, r.id))!);
  }

  // ---------- licence exceptions ----------

  async exceptions(p: Principal, state?: string) {
    const q = this.db('import_exceptions as e').join('import_jobs as j', 'j.id', 'e.import_id').where({ 'e.tenant_id': p.tenantId });
    if (state) q.andWhere({ 'e.state': state });
    const rows = (await q.orderBy('e.requested_at', 'desc').limit(500).select('e.*', 'j.ref as import_ref', 'j.item_id', 'j.item_name', 'j.label', 'j.state as import_state', 'j.repository_id')) as Record<string, unknown>[];
    const people = [...new Set(rows.flatMap((r) => [r.requested_by, r.decided_by]).filter((x): x is string => typeof x === 'string'))];
    const names = new Map(((await this.db('users').whereIn('id', people).select('id', 'display_name')) as { id: string; display_name: string }[]).map((u) => [u.id, u.display_name]));
    return rows
      .filter((r) => clears(p.clearance, r.label as Label))
      .map((r) => {
        const e = exceptionFrom(r);
        return { id: e.id, ref: e.ref, licence: e.licence, reason: e.reason, state: e.state, import: { id: e.import_id, ref: String(r.import_ref), item: String(r.item_id), itemName: String(r.item_name), state: String(r.import_state), label: r.label }, requestedBy: e.requested_by, requestedByName: names.get(e.requested_by) ?? null, requestedAt: e.requested_at, decidedBy: e.decided_by, decidedByName: e.decided_by ? (names.get(e.decided_by) ?? null) : null, decidedAt: e.decided_at, decisionNote: e.decision_note };
      });
  }

  /** The legal-review decision. Whoever requested the exception (or the import) cannot decide it. */
  async decide(p: Principal, id: string, decision: 'grant' | 'refuse', note: string | null, traceId?: string | null) {
    const raw = await this.db('import_exceptions').where({ tenant_id: p.tenantId, id }).first();
    if (!raw) throw notFound('Licence exception');
    const e = exceptionFrom(raw);
    const r = (await this.row(p.tenantId, e.import_id))!;
    if (!clears(p.clearance, r.label)) throw notFound('Licence exception');
    if (e.state !== 'pending') throw new HttpProblem(409, 'Conflict', `${e.ref} is already ${e.state}${e.decided_by ? '' : ''}.`, { extensions: { state: e.state, decidedBy: e.decided_by, decidedAt: e.decided_at } });
    if (e.requested_by === p.userId || r.requested_by === p.userId) throw forbidden('Dual control: whoever requested the import or its exception cannot decide it.', { step: 'dual-control' });
    const t = Date.now();
    const nUpd = await this.db('import_exceptions').where({ id, state: 'pending' }).update({ state: decision === 'grant' ? 'granted' : 'refused', decided_by: p.userId, decided_at: t, decision_note: note });
    if (!nUpd) throw conflict(`${e.ref} was decided by someone else just now.`);
    if (decision === 'grant') {
      const state: ImportState = r.mode === 'bundle' ? 'queued for bundle' : 'queued';
      await this.update(r.id, { licence_status: 'exception granted', state, note: null });
      await this.appendLog(r.id, { at: t, title: 'Licence exception granted', meta: `${e.ref} by ${p.displayName}${note ? `: ${note}` : ''}`, tone: 'ok' });
      if (state === 'queued' && r.state === 'waiting on licence') await (r.kind === 'dataset' ? this.datasets.enqueue(p.tenantId, r.id, r.requested_by) : this.enqueue(p.tenantId, r.id, r.requested_by));
    } else {
      await this.update(r.id, { licence_status: 'exception refused', state: 'refused', note: `Licence exception ${e.ref} refused`, finished_at: t, error: `The licence exception for ${e.licence} was refused${note ? `: ${note}` : '.'}` });
      await this.appendLog(r.id, { at: t, title: 'Licence exception refused', meta: `${e.ref} by ${p.displayName}${note ? `: ${note}` : ''}`, tone: 'danger' });
    }
    await this.audit(p, p.tenantId, decision === 'grant' ? 'import.exception.granted' : 'import.exception.refused', { exception: e.id, ref: e.ref, import: r.id }, { licence: e.licence, note, requestedBy: e.requested_by }, r.label, traceId);
    await this.notifyUsers(p.tenantId, [e.requested_by, r.requested_by], decision === 'grant' ? 'Licence exception granted' : 'Licence exception refused', `${e.ref} for ${r.item_name} (${e.licence}) was ${decision === 'grant' ? 'granted; the import continues' : 'refused; nothing is fetched'}.`, r.label);
    return (await this.exceptions(p)).find((x) => x.id === id)!;
  }

  // ---------- bundle mode ----------

  /** The request list staging reads to build the next bundle (format `exprsn-import-requests/1`). */
  async bundleRequests(tenantId: string | null) {
    const q = this.db('import_jobs as j').join('import_repositories as r', 'r.id', 'j.repository_id').where({ 'j.state': 'queued for bundle' });
    if (tenantId) q.andWhere({ 'j.tenant_id': tenantId });
    const rows = (await q.select('j.*', 'r.type as repo_type', 'r.base_url as repo_url', 'r.name as repo_name').orderBy('j.created_at')) as Record<string, unknown>[];
    return {
      format: 'exprsn-import-requests/1',
      generatedAt: new Date().toISOString(),
      requests: rows.map((x) => {
        const r = importFrom(x);
        return { id: r.id, ref: r.ref, tenant: r.tenant_id, repository: { type: String(x.repo_type), baseUrl: String(x.repo_url), name: String(x.repo_name) }, item: r.item_id, revision: r.revision, variant: r.options.variant ?? null, manifestDigest: r.options.manifestDigest ?? null, files: r.files.map((f) => ({ name: f.name, pin: f.pin })), licence: r.licence, path: `imports/${r.id}/`, requestedAt: new Date(r.created_at).toISOString() };
      })
    };
  }

  /** Scheduled: requests waiting for the bundle whose files a promoted bundle now carries continue as ordinary imports. */
  async bundleMatch(tenantId: string): Promise<{ matched: number }> {
    const waiting = ((await this.db('import_jobs').where({ tenant_id: tenantId, state: 'queued for bundle' })) as Record<string, unknown>[]).map(importFrom);
    if (!waiting.length) return { matched: 0 };
    const files = await promotedModelFiles({ s: this.s() });
    let matched = 0;
    for (const r of waiting) {
      const dir = `imports/${r.id}`;
      const mine = files.filter((f) => f.path.startsWith(`${dir}/`) && !f.path.endsWith('/import.json'));
      if (!mine.length) continue;
      const pinned: PinnedFile[] = mine.map((f) => {
        const name = f.path.slice(dir.length + 1);
        const asked = r.files.find((x) => x.name === name);
        return { name, size: f.size, pin: asked?.pin && asked.pin.startsWith('sha256:') ? asked.pin : `sha256:${f.sha256}`, format: name === 'manifest.json' ? 'manifest' : (asked?.format ?? formatInBundle(name)), mediaType: asked?.mediaType ?? null, done: 0, parts: [], sha256: null, blob: null, state: 'pending' };
      });
      await this.update(r.id, { state: 'queued', files: pinned, options: { ...r.options, bundleDir: dir } as ImportOptions, note: `Arrived in bundle ${mine[0]!.bundle}` });
      await this.appendLog(r.id, { at: Date.now(), title: 'Arrived in the bundle', meta: `${mine.length} files in ${[...new Set(mine.map((f) => f.bundle))].join(', ')}`, tone: 'ok' });
      await this.audit(null, tenantId, 'import.bundle.matched', { import: r.id, ref: r.ref }, { bundles: [...new Set(mine.map((f) => f.bundle))], files: mine.length }, r.label);
      await this.enqueue(tenantId, r.id, r.requested_by);
      matched++;
    }
    return { matched };
  }

  // ---------- the import job ----------

  private async discardParts(r: ImportRow): Promise<void> {
    await this.s().blobs.deletePrefix(`imports/parts/${r.tenant_id}/${r.id}/`).catch(() => 0);
  }

  async runModel(importId: string, ctx: JobContext): Promise<unknown> {
    const raw = await this.db('import_jobs').where({ id: importId }).first();
    if (!raw) return { skipped: 'gone' };
    let r = importFrom(raw);
    if (r.state !== 'queued' && r.state !== 'running') return { skipped: r.state };
    const repo = await this.repositories.get(r.tenant_id, r.repository_id).catch(() => null);
    const fail = async (err: unknown) => {
      const fresh = (await this.row(r.tenant_id, r.id))!;
      if (fresh.state === 'cancelled') {
        await this.discardParts(fresh);
        return { cancelled: true };
      }
      if (err instanceof RateLimited && repo) {
        const until = await this.repositories.markRateLimited(repo, err);
        await this.update(r.id, { state: 'queued', stage: 'Waiting on the source', note: `${repo.name} is rate limiting; resumes at ${new Date(until).toISOString()}` });
        await this.appendLog(r.id, { at: Date.now(), title: 'Rate limited', meta: `backing off until ${new Date(until).toISOString()}`, tone: 'warn' });
        await this.enqueue(r.tenant_id, r.id, r.requested_by, until);
        return { rateLimited: until };
      }
      const refused = err instanceof ImportRefused;
      const msg = (err as Error).message.slice(0, 1000);
      await this.update(r.id, { state: refused ? 'refused' : 'failed', stage: null, note: msg.slice(0, 500), error: msg, finished_at: Date.now() });
      await this.appendLog(r.id, { at: Date.now(), title: refused ? 'Refused' : 'Failed', meta: msg, tone: 'danger' });
      if (refused) await this.discardParts(fresh);
      await this.audit(null, r.tenant_id, refused ? 'import.refused' : 'import.failed', { import: r.id, ref: r.ref }, { error: msg, ...(refused ? { reason: (err as ImportRefused).reason } : {}) }, r.label);
      await this.notifyUsers(r.tenant_id, [r.requested_by], refused ? `Import ${r.ref} refused` : `Import ${r.ref} failed`, msg, r.label);
      throw err instanceof Error ? err : new Error(String(err));
    };
    try {
      if (!repo) throw new Error('The repository was deleted.');
      if (repo.state !== 'active') throw new Error(`${repo.name} is ${repo.state}.`);
      await this.update(r.id, { state: 'running', stage: 'Pinning', started_at: r.started_at ?? Date.now(), error: null });
      await ctx.progress(2, 'Pinning');
      const bundleDir = typeof (r.options as Record<string, unknown>).bundleDir === 'string' ? String((r.options as Record<string, unknown>).bundleDir) : null;
      const adapter: RepositoryAdapter = bundleDir ? bundleAdapter : ADAPTERS[repo.type];
      const actx: AdapterContext = this.repositories.context(repo, ctx.signal);
      const itemId = bundleDir ?? r.item_id;
      // Re-read the source at the pinned revision: a digest that changed under it refuses the import.
      const detail = await adapter.inspect!(actx, itemId, bundleDir ? null : r.revision);
      if (!bundleDir && r.revision && detail.revision !== r.revision) throw new ImportRefused(`The source now resolves ${r.item_id} to ${detail.revision.slice(0, 19)}, not the pinned ${r.revision.slice(0, 19)}.`, 'revision');
      for (const f of r.files) {
        const now = detail.files.find((x) => x.name === f.name);
        if (!now) throw new ImportRefused(`${f.name} is no longer in the source at the pinned revision.`, 'digest');
        if (f.pin && now.pin && now.pin !== f.pin) throw new ImportRefused(`${f.name} changed under the same revision: pinned ${f.pin.slice(0, 23)}, now ${now.pin.slice(0, 23)}. Nothing is registered.`, 'digest');
        if (!f.pin) f.pin = now.pin;
        if (f.size == null) f.size = now.size;
      }
      const fetched = normaliseLicence(detail.licence);
      if (fetched !== 'unknown' && fetched !== 'other' && fetched !== r.licence && r.licence_status === 'allowed' && !(await this.allowedLicences(r.tenant_id)).has(fetched)) throw new ImportRefused(`The licence read from the fetched files is ${fetched}, not ${r.licence} as at request time, and it is outside the tenant's allow-list. Request the import again.`, 'licence');
      await this.update(r.id, { files: r.files, stage: 'Downloading' });
      await this.appendLog(r.id, { at: Date.now(), title: 'Digest pinned', meta: `${detail.revision.slice(0, 40)}; licence ${fetched} read from ${detail.licenceSource}`, tone: 'ok' });
      // Download, resuming from the stored parts.
      const total = Math.max(1, r.files.reduce((a, f) => a + (f.size ?? 0), 0));
      let before = r.files.reduce((a, f) => a + (f.state === 'verified' ? (f.size ?? f.done) : 0), 0);
      for (let i = 0; i < r.files.length; i++) {
        if (r.files[i]!.state === 'verified') continue;
        await this.download(r, i, (from) => adapter.open!(actx, itemId, detail.revision, r.files[i]!, from), async (bytes) => ctx.progress(5 + Math.min(70, ((before + bytes) / total) * 70), `${r.files[i]!.name}: ${bytes.toLocaleString('en-US')} bytes`));
        before += r.files[i]!.size ?? r.files[i]!.done;
      }
      const stored = r.files.reduce((a, f) => a + (f.size ?? f.done), 0);
      await this.update(r.id, { stored_bytes: stored, stage: 'Registering' });
      await this.appendLog(r.id, { at: Date.now(), title: 'Downloaded and verified', meta: `${r.files.length} files, ${stored.toLocaleString('en-US')} bytes; digests matched the pins; no pickle`, tone: 'ok' });
      await ctx.progress(78, 'Registering');
      r = (await this.row(r.tenant_id, r.id))!;
      if (r.target === 'classifiers') {
        const c = await this.registerClassifier(r, repo, detail);
        await ctx.progress(100, `Registered classifier ${c.slug}`);
        return { classifier: c.id };
      }
      const model = r.files.some((f) => f.format === 'manifest') ? await this.registerManifest(r, repo, detail) : await this.registerConverted(r, repo, detail, ctx);
      await this.finish(r, repo, detail, model);
      await ctx.progress(100, `Registered ${model.name}`);
      return { model: model.name, digest: model.expected_digest };
    } catch (err) {
      return fail(err);
    }
  }

  /** Streams one file into parts (resuming), checks its first bytes and its pin, then stores it content-addressed. */
  private async download(r: ImportRow, idx: number, open: (from: number) => Promise<{ body: AsyncIterable<Uint8Array>; partial: boolean }>, progress: (bytes: number) => Promise<void>): Promise<void> {
    const s = this.s();
    const f = r.files[idx]!;
    const partBytes = s.cfg.IMPORT_PART_BYTES;
    let hash = createHash('sha256');
    let done = 0;
    let head: Buffer = Buffer.alloc(0);
    // Resume: re-read the stored parts (their bytes feed the digest again).
    const kept: PinnedFile['parts'] = [];
    for (const part of f.parts) {
      const b = await s.blobs.get(part.key);
      if (!b || b.length !== part.bytes) break;
      hash.update(b);
      if (head.length < 64) head = Buffer.concat([head, b.subarray(0, 64 - head.length)]);
      done += b.length;
      kept.push(part);
    }
    f.parts = kept;
    f.state = 'downloading';
    const opened = await open(done);
    if (done > 0 && !opened.partial) {
      // The source ignored the range and sent the whole file: start over with it.
      await s.blobs.deletePrefix(`imports/parts/${r.tenant_id}/${r.id}/${idx}/`);
      f.parts = [];
      done = 0;
      head = Buffer.alloc(0);
      hash = createHash('sha256');
    }
    let buf: Buffer[] = [];
    let bufLen = 0;
    const flush = async () => {
      if (!bufLen) return;
      const key = `imports/parts/${r.tenant_id}/${r.id}/${idx}/${String(f.parts.length).padStart(6, '0')}`;
      const data = Buffer.concat(buf, bufLen);
      await s.blobs.put(key, data, 'application/octet-stream');
      f.parts.push({ key, bytes: data.length });
      f.done = done;
      buf = [];
      bufLen = 0;
      await this.update(r.id, { files: r.files });
      await progress(done);
    };
    for await (const chunk of opened.body) {
      const c = Buffer.from(chunk);
      if (head.length < 64) {
        head = Buffer.concat([head, c.subarray(0, 64 - head.length)]);
        if (head.length >= 16 || (f.size != null && head.length >= f.size)) {
          const problem = f.format === 'metadata' || f.format === 'manifest' ? (['pickle', 'zip'].includes(sniffHead(head)) ? `${f.name} is a pickle checkpoint by its contents. Pickle is never imported.` : null) : contentProblem(f.name, f.format, head);
          if (problem) throw new ImportRefused(`${problem} Refused at staging; the parts are discarded.`, 'pickle');
        }
      }
      hash.update(c);
      done += c.length;
      if (f.size != null && done > f.size) throw new ImportRefused(`${f.name} is longer than the ${f.size.toLocaleString('en-US')} bytes the source listed.`, 'digest');
      if (done > s.cfg.IMPORT_MAX_BYTES) throw new Error(`${f.name} is larger than IMPORT_MAX_BYTES.`);
      buf.push(c);
      bufLen += c.length;
      if (bufLen >= partBytes) await flush();
    }
    await flush();
    if (head.length && head.length < 16) {
      const problem = f.format === 'metadata' || f.format === 'manifest' ? null : contentProblem(f.name, f.format, head);
      if (problem) throw new ImportRefused(problem, 'pickle');
    }
    const hex = hash.digest('hex');
    // Verify the pin: sha256 for LFS objects and OCI blobs, the git blob id for small files kept in git.
    let ok = true;
    if (f.pin?.startsWith('sha256:')) ok = f.pin.slice(7) === hex;
    else if (f.pin?.startsWith('gitsha1:')) {
      const g = createHash('sha1').update(`blob ${done}\0`);
      for (const part of f.parts) g.update((await s.blobs.get(part.key))!);
      ok = f.pin.slice(8) === g.digest('hex');
    }
    if (!ok) {
      await s.blobs.deletePrefix(`imports/parts/${r.tenant_id}/${r.id}/${idx}/`);
      f.parts = [];
      f.done = 0;
      f.state = 'failed';
      await this.update(r.id, { files: r.files });
      throw new ImportRefused(`${f.name} does not match its pinned digest ${f.pin!.slice(0, 23)}… (got sha256 ${hex.slice(0, 16)}…). Nothing is registered.`, 'digest');
    }
    const key = `imports/blobs/sha256/${hex}`;
    const existing = await s.blobs.getStream(key);
    if (existing) existing.stream.destroy();
    else {
      const parts = f.parts.slice();
      await s.blobs.putStream(key, (async function* () {
        for (const part of parts) yield (await s.blobs.get(part.key))!;
      })(), 'application/octet-stream');
    }
    await s.blobs.deletePrefix(`imports/parts/${r.tenant_id}/${r.id}/${idx}/`);
    Object.assign(f, { sha256: hex, blob: key, parts: [], done, size: f.size ?? done, state: 'verified' });
    await this.update(r.id, { files: r.files });
  }

  /** An Ollama manifest: its layers were verified against the pins; the draft's digest is the manifest's. */
  private async registerManifest(r: ImportRow, repo: RepositoryRow, detail: ModelDetail): Promise<ModelRow> {
    const s = this.s();
    const mf = r.files.find((f) => f.format === 'manifest')!;
    const bytes = (await s.blobs.get(mf.blob!))!;
    const manifest = JSON.parse(bytes.toString('utf8')) as { config?: { digest: string }; layers?: { digest: string; mediaType: string; size: number }[] };
    const have = new Set(r.files.map((f) => f.pin));
    for (const l of [...(manifest.layers ?? []), ...(manifest.config ? [manifest.config] : [])]) if (!have.has(l.digest)) throw new ImportRefused(`The manifest names ${l.digest.slice(0, 19)}, which was not fetched and verified.`, 'digest');
    if (!(manifest.layers ?? []).some((l) => l.mediaType === 'application/vnd.ollama.image.model')) throw new ImportRefused('The manifest has no model layer.', 'format');
    const digest = `sha256:${mf.sha256}`;
    if (r.options.manifestDigest && r.options.manifestDigest !== digest) throw new ImportRefused(`The manifest fetched has digest ${digest.slice(0, 19)}, not the ${r.options.manifestDigest.slice(0, 19)} pinned at request time.`, 'digest');
    const tag = r.options.tag!;
    const cfgFile = r.files.find((f) => f.format === 'metadata' && f.pin === manifest.config?.digest);
    let config: { model_family?: string; model_type?: string; file_type?: string } = {};
    if (cfgFile?.blob) {
      try {
        config = JSON.parse(((await s.blobs.get(cfgFile.blob)) ?? Buffer.from('{}')).toString('utf8')) as typeof config;
      } catch {
        config = {};
      }
    }
    return this.createDraft(r, repo, detail, { name: tag, digest, format: 'gguf', quantization: config.file_type ?? null, family: config.model_family ?? r.options.family ?? null, parameterSize: config.model_type ?? null, sizeBytes: (manifest.layers ?? []).reduce((a, l) => a + l.size, 0) });
  }

  /** Safetensors or a published GGUF: staged as artefacts the GPU worker reads, converted (or packaged), then registered. */
  private async registerConverted(r: ImportRow, repo: RepositoryRow, detail: ModelDetail, ctx: JobContext): Promise<ModelRow> {
    const s = this.s();
    if (!s.trainer.available) throw new Error(s.trainer.reason ?? 'No training worker is configured.');
    const tag = r.options.tag!;
    if (await s.gateway.repo.modelByName(tag)) throw new Error(`${tag} is already in the model catalogue.`);
    await this.update(r.id, { stage: 'Converting' });
    const staged: NonNullable<Parameters<typeof s.trainer.convert>[0]['source']>['files'] = [];
    let extra = 0;
    for (const f of r.files) {
      if (f.format !== 'gguf' && f.format !== 'safetensors' && f.format !== 'metadata') continue;
      const got = await s.blobs.getStream(f.blob!);
      if (!got) throw new Error(`${f.name} is missing from the staging store.`);
      const name = artifactName(f.name);
      const a = await s.training.worker.storeArtifact(r.tenant_id, r.id, name, 'other', got.stream as AsyncIterable<Buffer>);
      if (a.sha256 !== f.sha256) throw new ImportRefused(`${f.name} changed in the staging store.`, 'digest');
      extra += a.bytes;
      staged.push({ name: f.name, artifact: name, sha256: a.sha256, bytes: a.bytes, format: f.format });
    }
    const weights = staged.find((x) => x.format === 'gguf' || x.format === 'safetensors');
    if (!weights) throw new ImportRefused('No GGUF or safetensors weights were fetched.', 'format');
    const grant = await s.training.worker.artifactGrant(r.tenant_id, r.id, 24 * 3_600_000);
    await this.appendLog(r.id, { at: Date.now(), title: `Converting${r.options.quantization === 'as-is' ? '' : ` to GGUF ${r.options.quantization}`}`, meta: 'on the training pool', tone: '' });
    await ctx.progress(82, 'Converting on the training pool');
    const conv = await s.trainer.convert({ job: r.id, name: tag, checkpoint: { step: 0, ref: `${ARTIFACT_REF}${weights.artifact}`, at: Date.now() }, baseModel: `${repo.type}:${r.item_id}@${r.revision ?? detail.revision}`, quantization: r.options.quantization ?? 'Q4_K_M', source: { kind: 'import', repository: repo.base_url, item: r.item_id, revision: r.revision ?? detail.revision, files: staged, artifacts: grant } });
    if (!/^(sha256:)?[a-f0-9]{64}$/i.test(conv.digest)) throw new Error(`The training worker returned a digest that is not sha256 (${conv.digest.slice(0, 40)}).`);
    await this.update(r.id, { stored_bytes: r.stored_bytes + extra });
    const manifest = { conversion: { tool: conv.tool, quantization: conv.quantization, artifact: conv.artifact, digest: conv.digest } };
    await this.appendLog(r.id, { at: Date.now(), title: 'Converted', meta: `${conv.quantization} with ${conv.tool}; digest ${conv.digest.slice(0, 23)}`, tone: 'ok' });
    return this.createDraft(r, repo, detail, { name: conv.name || tag, digest: conv.digest.startsWith('sha256:') ? conv.digest : `sha256:${conv.digest}`, format: 'gguf', quantization: conv.quantization, family: detail.family ?? r.options.family ?? null, parameterSize: detail.parameters, sizeBytes: conv.sizeBytes, extra: manifest });
  }

  private async createDraft(r: ImportRow, repo: RepositoryRow, detail: ModelDetail, m: { name: string; digest: string; format: string; quantization: string | null; family: string | null; parameterSize: string | null; sizeBytes: number; extra?: Record<string, unknown> }): Promise<ModelRow> {
    const s = this.s();
    const g = s.gateway.repo;
    const user = await this.db('users').where({ id: r.requested_by }).first('username');
    let model: ModelRow;
    try {
      model = await g.createModel({ name: m.name, source: `import:${r.ref} ${repo.name} ${r.item_id}@${(r.revision ?? detail.revision).slice(0, 80)}`.slice(0, 500), expectedDigest: m.digest, license: { name: r.licence ?? 'unknown', notes: `Read from ${detail.licenceSource}; ${r.licence_status}.`.slice(0, 1000), recordedBy: String(user?.username ?? r.requested_by), recordedAt: Date.now() }, label: r.label, notes: (r.options.notes ?? `Imported from ${repo.name}: ${r.item_id} at ${(r.revision ?? '').slice(0, 40)} (${r.ref}).`).slice(0, 1000), requestedBy: r.requested_by, requestedTenant: r.tenant_id });
    } catch (err) {
      if (isUniqueViolation(err)) throw new Error(`${m.name} is already in the model catalogue.`, { cause: err });
      throw err;
    }
    await g.updateModel(model.id, { format: m.format, quantization: m.quantization, family: m.family, parameter_size: m.parameterSize?.slice(0, 40) ?? null, size_bytes: m.sizeBytes, context_length: detail.contextLength, capabilities: r.options.capabilities ?? [] });
    if (m.extra) await this.update(r.id, { manifest: m.extra });
    return (await g.model(model.id))!;
  }

  /**
   * B-3806: a text-classification model becomes a classifier with the `imported` engine: its verified files stay in
   * the blob store (content-addressed, where the classifier worker reads them) and the classifier's config names them.
   */
  private async registerClassifier(r: ImportRow, repo: RepositoryRow, detail: ModelDetail): Promise<{ id: string; slug: string }> {
    const s = this.s();
    const fresh = (await this.row(r.tenant_id, r.id))!;
    const files = fresh.files.filter((f) => f.blob).map((f) => ({ name: f.name, key: f.blob!, sha256: f.sha256, bytes: f.size ?? f.done }));
    const config = files.find((f) => /(^|\/)config\.json$/.test(f.name));
    let labels: string[] = [];
    if (config) {
      try {
        const cfg = JSON.parse((await this.stagedBytes(config.key, 4 * 1024 * 1024)).toString('utf8')) as { id2label?: Record<string, string> };
        labels = Object.values(cfg.id2label ?? {}).map((l) => String(l).slice(0, 100));
      } catch {
        /* the model's labels are named on the Classifiers screen */
      }
    }
    const user = await this.db('users').where({ id: r.requested_by }).first('username', 'display_name');
    const slugBase = (r.options.tag ?? r.item_name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 55) || 'imported';
    const c = await s.guard.classifiers.createImported(r.tenant_id, { name: r.options.tag ?? r.item_name, slug: `${slugBase}-${r.ref.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`.slice(0, 63), labels: labels.length ? labels : ['positive', 'negative'], model: { importId: r.id, ref: r.ref, name: r.item_id, revision: detail.revision, files }, description: `Imported from ${repo.name}: ${r.item_id} (${r.ref})` }, { userId: r.requested_by, name: String(user?.display_name ?? '') });
    const manifest: Record<string, unknown> = {
      format: 'exprsn-import-manifest/1',
      import: r.ref,
      source: { repository: repo.name, type: repo.type, baseUrl: repo.base_url, item: r.item_id, revision: r.revision ?? detail.revision },
      files: fresh.files.map((f) => ({ name: f.name, pin: f.pin, sha256: f.sha256, bytes: f.size ?? f.done, format: f.format })),
      licence: { id: r.licence, source: detail.licenceSource, status: r.licence_status },
      label: r.label,
      attribution: r.attribution,
      requester: { id: r.requested_by, username: user?.username ?? null },
      classifier: { id: c.id, slug: c.slug, labels: c.config.labels.map((l) => l.label) },
      registeredAt: new Date().toISOString()
    };
    const key = `${s.cfg.OPENBAO_KEY_PREFIX}import-manifests`;
    manifest.signature = { key, value: await s.kms.hmac(key, canonicalJson(manifest)) };
    await this.update(r.id, { state: 'complete', stage: null, progress: 100, classifier_id: c.id, manifest, note: `Classifier ${c.slug} (imported engine)`, finished_at: Date.now() } as never);
    await this.appendLog(r.id, { at: Date.now(), title: 'Registered', meta: `Classifiers: ${c.slug}, engine imported, ${c.config.labels.length} labels from the model's config${s.cfg.CLASSIFIER_WORKER_URL ? '' : '; no classifier worker is configured (CLASSIFIER_WORKER_URL), so it cannot score yet'}`, tone: s.cfg.CLASSIFIER_WORKER_URL ? 'ok' : 'warn' });
    await this.audit(null, r.tenant_id, 'import.completed', { import: r.id, ref: r.ref, classifier: c.id }, { slug: c.slug, revision: r.revision, licence: r.licence, signature: (manifest.signature as { value: string }).value.slice(0, 16) }, r.label);
    await this.notifyUsers(r.tenant_id, [r.requested_by], `Import ${r.ref} finished`, `${c.slug} is registered as a classifier with the imported engine; name its eval set and evaluate it under Classifiers.`, r.label);
    return { id: c.id, slug: c.slug };
  }

  private async finish(r: ImportRow, repo: RepositoryRow, detail: ModelDetail, model: ModelRow): Promise<void> {
    const s = this.s();
    const user = await this.db('users').where({ id: r.requested_by }).first('username', 'display_name');
    const gate = await this.gateOf(repo, r.item_id);
    const fresh = (await this.row(r.tenant_id, r.id))!;
    const manifest: Record<string, unknown> = {
      format: 'exprsn-import-manifest/1',
      import: r.ref,
      source: { repository: repo.name, type: repo.type, baseUrl: repo.base_url, item: r.item_id, revision: r.revision ?? detail.revision, bundle: (r.options as Record<string, unknown>).bundleDir ?? null },
      files: fresh.files.map((f) => ({ name: f.name, pin: f.pin, sha256: f.sha256, bytes: f.size ?? f.done, format: f.format })),
      licence: { id: r.licence, source: detail.licenceSource, status: r.licence_status },
      label: r.label,
      attribution: r.attribution,
      requester: { id: r.requested_by, username: user?.username ?? null },
      gate: gate ? { account: gate.account, acceptedBy: gate.acceptedBy, acceptedAt: gate.acceptedAt } : null,
      model: { id: model.id, name: model.name, expectedDigest: model.expected_digest },
      ...(fresh.manifest ?? {}),
      registeredAt: new Date().toISOString()
    };
    const key = `${s.cfg.OPENBAO_KEY_PREFIX}import-manifests`;
    manifest.signature = { key, value: await s.kms.hmac(key, canonicalJson(manifest)) };
    await this.update(r.id, { state: 'complete', stage: null, progress: 100, model_id: model.id, manifest, note: `Draft ${model.name}, digest ${String(model.expected_digest).slice(0, 19)}`, finished_at: Date.now() });
    await this.appendLog(r.id, { at: Date.now(), title: 'Registered', meta: `Models: draft tag ${model.name}, expected digest ${model.expected_digest}`, tone: 'ok' });
    await this.audit(null, r.tenant_id, 'import.completed', { import: r.id, ref: r.ref, model: model.id }, { name: model.name, expectedDigest: model.expected_digest, revision: r.revision, licence: r.licence, signature: (manifest.signature as { value: string }).value }, r.label);
    // An optional pool: placed and pulled as an import request on the Models screen would be.
    if (r.options.poolId) {
      const pool = await s.gateway.repo.pool(r.options.poolId);
      if (pool && labelRank(r.label) <= labelRank(pool.label_ceiling)) {
        try {
          await s.zones.assertAdmits(pool, r.label);
          await s.gateway.repo.place(model.id, pool.id, 'warm', r.requested_by);
          const job = await s.jobs.enqueue({ tenantId: r.tenant_id, type: 'model.pull', payload: { modelId: model.id, poolId: pool.id }, createdBy: r.requested_by, maxAttempts: 1 });
          await this.appendLog(r.id, { at: Date.now(), title: 'Pull queued', meta: `${pool.name}, job ${job.id}`, tone: '' });
        } catch (err) {
          await this.appendLog(r.id, { at: Date.now(), title: 'Not placed', meta: (err as Error).message, tone: 'warn' });
        }
      }
    }
    const admins = await s.notifications.usersWithRoles(r.tenant_id, ['model-admin']);
    await this.notifyUsers(r.tenant_id, [r.requested_by], `Import ${r.ref} finished`, `${model.name} is registered as a draft model with its digest pinned.`, r.label);
    await this.notifyUsers(r.tenant_id, admins.filter((u) => u !== r.requested_by), 'Draft model from an import', `${model.name} was imported from ${repo.name} (${r.ref}). It needs a pull, the evaluation and an approval under Models.`, r.label);
  }

  /** Reads a staged file back (for tests and the manifest). */
  async stagedBytes(blobKey: string, max = 64 * 1024 * 1024): Promise<Buffer> {
    const got = await this.s().blobs.getStream(blobKey);
    if (!got) throw notFound('Staged file');
    return readAll(got.stream as AsyncIterable<Uint8Array>, max);
  }

  sha(b: Buffer): string {
    return sha(b);
  }
}

/** A bundled file's format by its name: hub files by extension, Ollama layers by the prefix staging gives them. */
function formatInBundle(name: string): PinnedFile['format'] {
  if (/^(model|projector|adapter)-[a-f0-9]{12}$/.test(name)) return 'gguf';
  if (/^(config|license|template|params|system|messages)-[a-f0-9]{12}$/.test(name)) return 'metadata';
  return formatOf(name);
}

function sniffHead(head: Buffer): string {
  if (head.length >= 2 && head[0] === 0x80 && head[1]! >= 1 && head[1]! <= 5) return 'pickle';
  if (head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) return 'zip';
  return 'other';
}
