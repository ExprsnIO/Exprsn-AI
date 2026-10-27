import { labelRank, type Label } from '../authz/labels.js';
import { json } from '../db/knex.js';
import { isClassifierModel, type Evaluation, type ModelRow } from '../gateway/repo.js';
import { classifierModelDigest, ClassifierWorkerError, WORKER_FILE_NAME, type ClassifierWorker, type WorkerFile } from '../guardrails/classifier-worker.js';
import { MAX_IMPORTED_LABELS, type ImportedEngine } from '../guardrails/classifiers.js';
import { conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import type { Services } from '../services.js';
import { ImportRefused, type Check, type ImportRow, type PinnedFile, type RemoteFile } from './types.js';

/*
 * 1.7.0 (B-3806, second half): imported classifier engines. A text-classification model from a repository goes
 * through the model import (pinned revision, digests, pickle refused, licence, label) and is then served by the
 * classifier worker, because Ollama serves no sequence-classification heads:
 *
 * - the plan accepts it only as safetensors with its `config.json`, when a worker is configured;
 * - the job reads the labels from `config.json`, pushes the verified files to the worker, which checks each hash,
 *   recomputes the model digest and loads the model, and registers a draft model in the catalogue pinned by that
 *   digest (`format: safetensors`, capability `classification`);
 * - the model is evaluated (the worker's digest check and a smoke test) and approved under dual control like any
 *   model; a classifier of the `imported` engine names it, is measured on its eval set while both are drafts, and
 *   publishes only once the model is approved.
 *
 * The worker fetches nothing by itself. When it no longer holds a model (a new machine, a cleared directory), the
 * files are pushed again from the import's content-addressed blobs and checked the same way.
 */

export const CLASSIFIER_TASK = 'text-classification';
const SMOKE_TEXT = 'The delivery arrived on time and everything worked.';

/** What the import manifest keeps about a classifier model. */
export interface ClassifierModelManifest {
  digest: string;
  labels: string[];
  multiLabel: boolean;
  maxLength: number | null;
  architecture: string | null;
  files: WorkerFile[];
}

/** The files the worker takes: safetensors weights and the configuration and tokenizer files beside them. */
export const servedFile = (f: Pick<RemoteFile, 'name' | 'format'>): boolean => WORKER_FILE_NAME.test(f.name) && (f.format === 'safetensors' || (f.format === 'metadata' && !/\.md$/i.test(f.name)));

/**
 * The labels of a sequence-classification model, from its `config.json`. Refuses what the worker would not serve as
 * a classifier: no labels, a regression head, or a model that needs code from its repository.
 */
export function classifierLabels(config: unknown): { labels: string[]; multiLabel: boolean; architecture: string | null } {
  const c = (config && typeof config === 'object' ? config : {}) as Record<string, unknown>;
  if (c.auto_map || c.custom_pipelines) throw new ImportRefused('The model needs code from its repository (auto_map in config.json). Code from a repository is never run; only models of the built-in architectures are served.', 'format');
  if (c.problem_type === 'regression') throw new ImportRefused('The model has a regression head (problem_type: regression), not labels.', 'labels');
  const map = c.id2label && typeof c.id2label === 'object' && !Array.isArray(c.id2label) ? (c.id2label as Record<string, unknown>) : null;
  if (!map || !Object.keys(map).length) throw new ImportRefused('config.json names no labels (id2label), so the model cannot be served as a classifier.', 'labels');
  const ids = Object.keys(map).map(Number);
  if (ids.some((i) => !Number.isInteger(i) || i < 0) || new Set(ids).size !== ids.length || Math.max(...ids) !== ids.length - 1) throw new ImportRefused('The label ids in config.json (id2label) are not 0 to n-1.', 'labels');
  const labels = ids.sort((a, b) => a - b).map((i) => String(map[String(i)] ?? '').trim());
  if (labels.some((l) => !l || l.length > 100)) throw new ImportRefused('A label in config.json (id2label) is empty or longer than 100 characters.', 'labels');
  if (new Set(labels).size !== labels.length) throw new ImportRefused('config.json (id2label) names the same label twice.', 'labels');
  if (labels.length < 2) throw new ImportRefused('The model has one output (a regression or scoring head), not labels.', 'labels');
  if (labels.length > MAX_IMPORTED_LABELS) throw new ImportRefused(`The model has ${labels.length} labels; an imported classifier takes at most ${MAX_IMPORTED_LABELS}.`, 'labels');
  const arch = Array.isArray(c.architectures) && typeof c.architectures[0] === 'string' ? c.architectures[0].slice(0, 200) : typeof c.model_type === 'string' ? c.model_type.slice(0, 200) : null;
  return { labels, multiLabel: c.problem_type === 'multi_label_classification', architecture: arch };
}

export class ClassifierModels implements ImportedEngine {
  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  private get worker(): ClassifierWorker {
    return this.s().classifierWorker;
  }

  /** True for what the import path hands to the classifier worker instead of the gateway. */
  serves(classification: string | null): boolean {
    return classification === CLASSIFIER_TASK;
  }

  // ---------- the plan ----------

  /** The files a classifier import fetches by default: what the worker takes, from the repository's root. */
  select(files: RemoteFile[]): RemoteFile[] {
    return files.filter(servedFile);
  }

  /** The Format check of a text-classification model: safetensors with its configuration, from the repository's root. */
  formatCheck(selected: RemoteFile[], all: RemoteFile[], bundle: boolean): Check {
    if (bundle) return { name: 'Format', result: 'info', detail: 'Checked at staging (pickle refused before signing) and again here, file by file, when the bundle arrives.' };
    const weights = selected.filter((f) => f.format === 'safetensors');
    const odd = selected.filter((f) => !servedFile(f));
    const pickles = all.filter((f) => f.format === 'pickle');
    if (odd.some((f) => f.format === 'pickle')) return { name: 'Format', result: 'refused', detail: `${odd.filter((f) => f.format === 'pickle').map((f) => f.name).slice(0, 3).join(', ')}: pickle checkpoints are never imported. Nothing is written.` };
    if (odd.length) return { name: 'Format', result: 'refused', detail: `${odd.map((f) => f.name).slice(0, 3).join(', ')}: a classifier model is imported as safetensors weights with the configuration and tokenizer files in the repository's root.` };
    if (!weights.length) return { name: 'Format', result: 'refused', detail: pickles.length ? `Only pickle checkpoints are published (${pickles.map((f) => f.name).slice(0, 3).join(', ')}). The classifier worker loads safetensors only; nothing is written.` : 'No safetensors weights are selected. The classifier worker loads safetensors only.' };
    if (!selected.some((f) => f.name === 'config.json')) return { name: 'Format', result: 'refused', detail: 'config.json is not selected (or not published): the labels of a classifier model are read from it.' };
    return { name: 'Format', result: 'passed', detail: `${weights.length} safetensors file${weights.length > 1 ? 's' : ''} with ${selected.length - weights.length} configuration and tokenizer file${selected.length - weights.length === 1 ? '' : 's'}, served as published (no conversion).` };
  }

  /** The Serving path check: a worker must be configured, and the model goes to no pool. */
  servingCheck(poolId: string | null | undefined): Check {
    if (!this.worker.available) return { name: 'Serving path', result: 'refused', detail: `${CLASSIFIER_TASK} models are served by the classifier worker, not by the gateway. ${this.worker.reason ?? 'No classifier worker is configured.'}` };
    if (poolId) return { name: 'Serving path', result: 'refused', detail: 'A classifier model is served by the classifier worker; it is not placed on a pool.' };
    return { name: 'Serving path', result: 'passed', detail: 'Served by the classifier worker as a classifier engine: registers in the model catalogue as a draft pinned by its digest; evaluation and approval follow as for any model.' };
  }

  // ---------- the job ----------

  private workerFiles(files: PinnedFile[]): WorkerFile[] {
    return files.filter(servedFile).map((f) => {
      if (!f.sha256 || !f.blob) throw new ImportRefused(`${f.name} was not fetched and verified.`, 'digest');
      return { name: f.name, sha256: f.sha256, bytes: f.size ?? f.done };
    });
  }

  /** Sends the worker every file it does not hold (all of them when `only` is empty) from the content-addressed blobs. */
  private async push(digest: string, files: WorkerFile[], only: string[] = []): Promise<void> {
    const s = this.s();
    for (const f of files) {
      if (only.length && !only.includes(f.name)) continue;
      // Where the import job keeps a verified file: content-addressed, so the key is the hash the manifest records.
      const got = await s.blobs.getStream(`imports/blobs/sha256/${f.sha256}`);
      if (!got) throw new Error(`${f.name} is missing from the staging store.`);
      if (got.size !== f.bytes) {
        got.stream.destroy();
        throw new ImportRefused(`${f.name} changed in the staging store.`, 'digest');
      }
      await this.worker.putFile(digest, f, got.stream);
    }
  }

  /** Has the worker check and load the model, pushing the files it says it does not hold. */
  private async ensureLoaded(m: ClassifierModelManifest) {
    try {
      return await this.worker.load(m.digest, m.files);
    } catch (err) {
      if (!(err instanceof ClassifierWorkerError) || err.code !== 'missing') throw err;
      await this.push(m.digest, m.files, err.missing);
      return this.worker.load(m.digest, m.files);
    }
  }

  /**
   * Called by the import job once every file is downloaded and verified: reads the labels, has the worker check and
   * load the files, and returns what the draft model is registered with.
   */
  async stage(r: ImportRow): Promise<{ manifest: ClassifierModelManifest; sizeBytes: number }> {
    const s = this.s();
    if (!this.worker.available) throw new Error(this.worker.reason ?? 'No classifier worker is configured.');
    const files = this.workerFiles(r.files);
    if (!files.some((f) => /\.safetensors$/i.test(f.name))) throw new ImportRefused('No safetensors weights were fetched.', 'format');
    const cfgFile = r.files.find((f) => f.name === 'config.json');
    if (!cfgFile?.blob) throw new ImportRefused('config.json was not fetched: the labels of a classifier model are read from it.', 'format');
    const raw = await s.blobs.get(cfgFile.blob);
    if (!raw || raw.length > 4 * 1024 * 1024) throw new ImportRefused('config.json is missing from the staging store or larger than 4 MB.', 'format');
    let config: unknown;
    try {
      config = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new ImportRefused('config.json is not JSON.', 'format');
    }
    const read = classifierLabels(config);
    const digest = classifierModelDigest(files);
    const manifest: ClassifierModelManifest = { digest, ...read, maxLength: null, files };
    let loaded;
    try {
      loaded = await this.ensureLoaded(manifest);
    } catch (err) {
      // The worker refusing the files (a hash that does not match, weights it cannot read) refuses the import.
      if (err instanceof ClassifierWorkerError && err.code === 'refused') throw new ImportRefused(err.message, 'worker');
      throw err;
    }
    if (loaded.labels.length !== read.labels.length || loaded.labels.some((l, i) => l !== read.labels[i])) throw new ImportRefused(`The classifier worker loaded the labels ${loaded.labels.slice(0, 8).join(', ')}, not the ${read.labels.slice(0, 8).join(', ')} of config.json.`, 'labels');
    return { manifest: { ...manifest, multiLabel: loaded.multiLabel, maxLength: loaded.maxLength, architecture: loaded.architecture ?? read.architecture }, sizeBytes: files.reduce((a, f) => a + f.bytes, 0) };
  }

  /**
   * After the draft model is registered: a draft classifier over it, when the requester may manage classifiers.
   * Returns what the import's result records.
   */
  async draftClassifier(r: ImportRow, model: ModelRow, m: ClassifierModelManifest): Promise<Record<string, unknown>> {
    const s = this.s();
    const want = r.options.classifierDraft;
    const base = { model: { id: model.id, name: model.name, digest: m.digest }, labels: m.labels, multiLabel: m.multiLabel };
    if (!want?.create) return { ...base, classifier: null };
    const user = (await this.db('users').where({ id: r.requested_by }).first('display_name')) as { display_name?: string } | undefined;
    const name = (want.name ?? '').trim() || model.name;
    try {
      const c = await s.guard.classifiers.create(r.tenant_id, { name: name.slice(0, 100), engine: 'imported', labels: [], model: model.name, description: `Imported from ${r.item_name} (${r.ref}); served by the classifier worker.`.slice(0, 1000) }, { userId: r.requested_by, name: String(user?.display_name ?? r.requested_by) });
      await s.imports.audit(null, r.tenant_id, 'classifier.created', { classifier: c.id, name: c.name }, { engine: c.engine, model: model.name, labels: m.labels, import: r.ref }, r.label);
      return { ...base, classifier: { id: c.id, slug: c.slug, name: c.name, evalSet: c.dataset } };
    } catch (err) {
      // The model is registered either way; a taken name is fixed by creating the classifier on its screen.
      return { ...base, classifier: null, classifierError: err instanceof HttpProblem ? (err.detail ?? err.message) : (err as Error).message };
    }
  }

  // ---------- the catalogue side ----------

  private async manifestOf(model: ModelRow): Promise<ClassifierModelManifest> {
    const row = (await this.db('import_jobs').where({ model_id: model.id, state: 'complete' }).orderBy('finished_at', 'desc').first('manifest')) as { manifest?: unknown } | undefined;
    const m = json<{ classifier?: ClassifierModelManifest } | null>(row?.manifest, null)?.classifier;
    if (!m || !Array.isArray(m.files) || !Array.isArray(m.labels)) throw conflict(`${model.name} has no import manifest; a classifier model enters through the Import screen.`);
    // The catalogue pins the digest: the manifest must still describe that model.
    if (model.expected_digest !== m.digest || classifierModelDigest(m.files) !== m.digest) throw conflict(`The import manifest of ${model.name} does not match its pinned digest.`);
    return m;
  }

  private async modelNamed(name: string): Promise<ModelRow> {
    const model = await this.s().gateway.repo.modelByName(name);
    if (!model) throw notFound('Model');
    if (!isClassifierModel(model)) throw conflict(`${model.name} is not a classifier model the classifier worker serves.`);
    return model;
  }

  async describe(modelName: string) {
    const model = await this.modelNamed(modelName);
    const m = await this.manifestOf(model);
    return { labels: m.labels, multiLabel: m.multiLabel, state: model.state, label: model.label };
  }

  async score(modelName: string, texts: string[], label: Label, use: 'draft' | 'published', signal?: AbortSignal): Promise<Record<string, number>[]> {
    const model = await this.modelNamed(modelName);
    if (model.state === 'retired') throw conflict(`${model.name} is retired.`);
    if (use === 'published' && model.state !== 'approved' && model.state !== 'deprecated') throw conflict(`${model.name} is ${model.state}; a published classifier scores only with an approved model.`);
    if (labelRank(model.label) < labelRank(label)) throw forbidden(`${model.name} is approved for data up to ${model.label}, not ${label}.`, { step: 'label' });
    if (labelRank(this.worker.labelCeiling) < labelRank(label)) throw forbidden(`The classifier worker is cleared for data up to ${this.worker.labelCeiling}, not ${label}.`, { step: 'zone' });
    const m = await this.manifestOf(model);
    try {
      return await this.worker.classify(m.digest, texts, signal);
    } catch (err) {
      if (!(err instanceof ClassifierWorkerError) || err.code !== 'missing') throw err;
      await this.ensureLoaded(m);
      return this.worker.classify(m.digest, texts, signal);
    }
  }

  /** The conformance run behind "evaluated" for a classifier model: the worker's digest check and one sentence. */
  async conformance(model: ModelRow, signal: AbortSignal): Promise<Evaluation['tests']> {
    const tests: Evaluation['tests'] = [];
    let m: ClassifierModelManifest | null = null;
    try {
      m = await this.manifestOf(model);
      const loaded = await this.ensureLoaded(m);
      if (loaded.labels.join('\n') !== m.labels.join('\n')) throw new Error(`The worker loaded the labels ${loaded.labels.slice(0, 8).join(', ')}, not those of the import.`);
      tests.push({ name: 'Digest check', ok: true, detail: `The classifier worker holds ${m.files.length} files matching ${m.digest.slice(0, 19)}${loaded.device ? ` (${loaded.device})` : ''}` });
    } catch (err) {
      tests.push({ name: 'Digest check', ok: false, detail: (err as Error).message.slice(0, 300) });
    }
    if (m && tests[0]!.ok) {
      try {
        const [scores] = await this.worker.classify(m.digest, [SMOKE_TEXT], signal);
        const missing = m.labels.filter((l) => typeof scores?.[l] !== 'number');
        if (missing.length) throw new Error(`No score for ${missing.slice(0, 5).join(', ')}`);
        const top = m.labels.reduce((a, l) => (scores![l]! > scores![a]! ? l : a), m.labels[0]!);
        tests.push({ name: 'Classification smoke test', ok: true, detail: `Scored ${m.labels.length} labels; top ${top} at ${scores![top]!.toFixed(2)}` });
      } catch (err) {
        tests.push({ name: 'Classification smoke test', ok: false, detail: (err as Error).message.slice(0, 300) });
      }
    }
    return tests;
  }

  /** The classifier models a tenant imported, for the New classifier form. */
  async list(tenantId: string, clearance: Label) {
    const rows = (await this.db('import_jobs').where({ tenant_id: tenantId, kind: 'model', state: 'complete' }).whereNotNull('model_id').orderBy('finished_at', 'desc').limit(500).select('ref', 'model_id', 'manifest', 'item_name', 'label')) as { ref: string; model_id: string; manifest: unknown; item_name: string; label: Label }[];
    const out: { name: string; state: string; label: Label; labels: string[]; multiLabel: boolean; architecture: string | null; import: string; source: string }[] = [];
    for (const r of rows) {
      const m = json<{ classifier?: ClassifierModelManifest } | null>(r.manifest, null)?.classifier;
      if (!m || labelRank(r.label) > labelRank(clearance)) continue;
      const model = await this.s().gateway.repo.model(r.model_id);
      if (!model || !isClassifierModel(model) || model.state === 'retired') continue;
      out.push({ name: model.name, state: model.state, label: model.label, labels: m.labels, multiLabel: m.multiLabel, architecture: m.architecture, import: r.ref, source: r.item_name });
    }
    return { worker: { available: this.worker.available, reason: this.worker.reason, labelCeiling: this.worker.available ? this.worker.labelCeiling : null }, models: out };
  }
}
