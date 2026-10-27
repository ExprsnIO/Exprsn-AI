import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import { clears, highest, type Label } from '../authz/labels.js';
import { rolesGranting } from '../authz/permissions.js';
import { effectivePermissions, type Principal } from '../authz/policy.js';
import { canonicalJson } from '../crypto/index.js';
import { MIN_SAMPLES } from '../guardrails/classifiers.js';
import { conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import type { SourceRow } from '../knowledge/service.js';
import type { SourceItem } from '../knowledge/sources.js';
import type { JobContext } from '../platform/jobs.js';
import type { Services } from '../services.js';
import { scrubRows, toJsonl, type Row, type ScrubReport } from '../training/scrub.js';
import { datasetRows, describeDataset, hasDatasetFetch, type RowBudget } from './adapters/dataset-rows.js';
import { normaliseLicence } from './formats.js';
import type { RepositoryRow } from './repositories.js';
import type { ImportService } from './service.js';
import { cellText, profile, type ColumnProfile } from './tabular.js';
import { ImportRefused, RateLimited, REPO_TYPE_INFO, type Cadence, type Check, type DatasetDetail, type DatasetResource, type DatasetSourceConfig, type DatasetTarget, type ImportRow, type ImportState, type LicenceStatus, type LogEntry, type Refresh, type SourceRecord } from './types.js';

/*
 * B-3804 to B-3806: dataset import. A request names a dataset of a confirmed repository, what to fetch of it (a
 * configuration and splits, or resources) and where it goes:
 *
 * - `training`: the rows, mapped to prompt and completion (or text), become a new version in `training_datasets`
 *   through the same scrub, hash and report as an inline version (B-3804).
 * - `knowledge`: a knowledge source of kind `dataset`: every row (or every group of rows) is a document whose title,
 *   text and metadata come from the mapped columns, refreshed on a schedule (B-3805).
 * - `classifiers`: the rows become the cases of a classifier's eval set, with a warning for every label below the
 *   minimum (B-3806).
 * - `store`: the rows are sealed with their manifest and hash; nothing is scrubbed or indexed.
 *
 * The checks are the wizard's: selection, size against the tenant's dataset quota (above it, or above
 * IMPORT_DATASET_MAX_ROWS, only a row limit is imported: the first rows in publication order), licence (the model
 * import's policy and exceptions), the PII preview, the destination and connectivity. The `imports.dataset` job
 * fetches through the import fetcher, scrubs and delivers; the signed manifest on the import records the source, the
 * revision, the hash of the rows kept, the scrub summary, licence, label, attribution and requester.
 */

export interface DatasetInput {
  repositoryId: string;
  item: string;
  config?: string | null;
  splits?: string[];
  resources?: string[];
  startPeriod?: string | null;
  endPeriod?: string | null;
  sample?: { rows: number } | null;
  dropColumns?: string[];
  target: DatasetTarget;
  label: Label;
  licence?: string | null;
  attribution?: string | null;
  exception?: { reason?: string | null } | null;
  workspaceId?: string | null;
  training?: { name: string; promptColumn?: string | null; completionColumn?: string | null; splits?: { train: number; val: number; test: number } };
  classifier?: { classifierId?: string | null; name?: string | null; engine?: 'linear' | 'llm' | 'guard'; profile?: string | null; textColumn: string; labelColumn: string; mode?: 'add' | 'replace'; minPerLabel?: number; evaluate?: boolean };
  knowledge?: { knowledgeBaseId?: string | null; name?: string | null; workspaceId?: string | null; embedModel?: string | null; titleColumn?: string | null; textColumns: string[]; metadataColumns?: string[]; idColumn?: string | null; groupBy?: string | null; refresh?: Refresh };
  store?: { name: string; retentionDays?: number | null };
}

/** What the job needs of the request, kept on the import (`options`). */
interface DatasetOptions {
  config: string | null;
  splits: string[];
  resources: string[];
  startPeriod: string | null;
  endPeriod: string | null;
  sample: number | null;
  dropColumns: string[];
  training?: { name: string; promptColumn: string | null; completionColumn: string | null; splits: { train: number; val: number; test: number } };
  classifier?: { classifierId: string | null; name: string | null; engine: 'linear' | 'llm' | 'guard'; profile: string | null; textColumn: string; labelColumn: string; mode: 'add' | 'replace'; minPerLabel: number; evaluate: boolean };
  knowledge?: { kbId: string; sourceId: string; name: string; createdBase: boolean };
  store?: { name: string; retentionDays: number | null };
  /** A refresh of this knowledge source (scheduled, or asked for on the Knowledge screen). */
  refreshOf?: string;
}

export interface DatasetPlan {
  repository: { id: string; name: string; type: string };
  item: string;
  name: string;
  revision: string | null;
  mode: 'direct' | 'bundle';
  target: DatasetTarget;
  selection: { config: string | null; splits: string[]; resources: { id: string; name: string; format: string; access: string }[] };
  rows: number | null;
  sizeBytes: number | null;
  sample: number | null;
  updates: string | null;
  licence: { id: string; source: string; allowed: boolean; recorded: boolean; needsException: boolean };
  label: Label;
  creates: string;
  columns: ColumnProfile[];
  previewRows: number;
  checks: Check[];
  blocked: boolean;
  waiting: boolean;
}

const sha = (b: Buffer | string) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const NAME63 = /^[a-z0-9][a-z0-9._-]{0,62}$/;
/** The most cases an eval set is read back with (`ClassifierService.cases`). */
const MAX_CASES = 20_000;
const MAX_LABELS = 20;
const CADENCES: readonly Cadence[] = ['daily', 'weekly', 'monthly', 'quarterly', 'yearly'];
const SDMX_FREQ: Record<string, Cadence> = { D: 'daily', B: 'daily', W: 'weekly', M: 'monthly', Q: 'quarterly', A: 'yearly' };
const TARGET_NAMES: Record<DatasetTarget, string> = { training: 'Training dataset', classifiers: 'Classifier eval set', knowledge: 'Knowledge set', store: 'Dataset store' };
const TARGET_PERMISSION: Record<DatasetTarget, string | null> = { training: 'training:manage', classifiers: 'classifiers:manage', knowledge: 'knowledge:manage', store: null };

/** When a cadence next falls due after `from` (calendar months for the monthly ones, in UTC). */
export function nextRefresh(cadence: Cadence | null, from: number): number | null {
  if (!cadence) return null;
  if (cadence === 'daily') return from + 24 * 3_600_000;
  if (cadence === 'weekly') return from + 7 * 24 * 3_600_000;
  const d = new Date(from);
  const months = cadence === 'monthly' ? 1 : cadence === 'quarterly' ? 3 : 12;
  const day = d.getUTCDate();
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1, d.getUTCHours(), d.getUTCMinutes()));
  // The same day of the month, or its last day when the month is shorter.
  next.setUTCDate(Math.min(day, new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate()));
  return next.getTime();
}

/** The cadence a refresh setting means now: its own, or the publisher's stated frequency. */
export function cadenceOf(refresh: Refresh, publisher: string | null): Cadence | null {
  if (refresh === 'manual') return null;
  if (refresh !== 'publisher') return refresh;
  return (CADENCES as readonly string[]).includes(publisher ?? '') ? (publisher as Cadence) : null;
}

/** The frequency an SDMX table states in its FREQ dimension, when every row has the same one. */
function frequencyIn(rows: SourceRecord[]): string | null {
  const key = rows[0] ? Object.keys(rows[0].values).find((k) => /^freq$/i.test(k)) : undefined;
  if (!key) return null;
  const all = new Set(rows.slice(0, 5000).map((r) => String(r.values[key] ?? '')));
  return all.size === 1 ? (SDMX_FREQ[[...all][0]!.toUpperCase()] ?? null) : null;
}

const summary = (r: ScrubReport) => ({ masked: r.masked, rowsAffected: r.rowsAffected, byKind: r.byKind, detectors: r.detectors });

/**
 * B-3805: the rows of a dataset as knowledge documents. One document per row, or per value of the grouping column;
 * the title, text and metadata come from the mapped columns, and every row carries its id (the mapped id column, the
 * id the source gives the row, or its position) so a cited passage leads back to the row.
 */
export function datasetItems(cfg: Pick<DatasetSourceConfig, 'name' | 'titleColumn' | 'textColumns' | 'metadataColumns' | 'idColumn' | 'groupBy'>, records: SourceRecord[], origin: string): SourceItem[] {
  const idOf = (r: SourceRecord, i: number) => (cfg.idColumn && cellText(r.values[cfg.idColumn]) ? cellText(r.values[cfg.idColumn]) : (r.id ?? String(i + 1))).slice(0, 200);
  const lines = (r: SourceRecord, cols: string[]) => cols.map((c) => [c, cellText(r.values[c]).trim()] as const).filter(([, v]) => v);
  const block = (r: SourceRecord, id: string): string => {
    const text = lines(r, cfg.textColumns);
    const meta = lines(r, cfg.metadataColumns);
    // One text column reads as prose; several keep their names.
    const body = text.length === 1 ? text[0]![1] : text.map(([c, v]) => `${c}: ${v}`).join('\n');
    return `${body}\n\nRow ${id} of ${cfg.name} (${origin})${r.part ? `, ${r.part}` : ''}${meta.length ? `\n${meta.map(([c, v]) => `${c}: ${v}`).join('\n')}` : ''}`;
  };
  const item = (key: string, name: string, body: string): SourceItem => {
    const data = Buffer.from(body, 'utf8');
    return { key, name: name.slice(0, 300), version: createHash('sha256').update(data).digest('hex'), size: data.length, read: async () => data, type: 'text/markdown' };
  };
  if (cfg.groupBy) {
    const groups = new Map<string, { r: SourceRecord; id: string }[]>();
    for (const [i, r] of records.entries()) {
      const g = cellText(r.values[cfg.groupBy]).trim() || '(empty)';
      groups.set(g, [...(groups.get(g) ?? []), { r, id: idOf(r, i) }]);
    }
    return [...groups.entries()].map(([g, rows]) =>
      item(
        `group:${g}`,
        `${cfg.name}: ${g}`,
        `# ${g}\n\n${rows.map(({ r, id }) => `## ${cfg.titleColumn && cellText(r.values[cfg.titleColumn]).trim() ? `${cellText(r.values[cfg.titleColumn]).trim().slice(0, 200)}, row ${id}` : `Row ${id}`}\n\n${block(r, id)}`).join('\n\n')}\n`
      )
    );
  }
  const seen = new Set<string>();
  const out: SourceItem[] = [];
  for (const [i, r] of records.entries()) {
    const id = idOf(r, i);
    // Two rows with the same id: the later one keeps its position, so neither replaces the other.
    const key = seen.has(id) ? `row:${id}#${i + 1}` : `row:${id}`;
    seen.add(id);
    const title = (cfg.titleColumn ? cellText(r.values[cfg.titleColumn]).trim() : '') || cfg.name;
    out.push(item(key, `${title.slice(0, 240)} (row ${id})`, `# ${title.slice(0, 300)}\n\n${block(r, id)}\n`));
  }
  return out;
}

export class DatasetImports {
  constructor(
    private readonly s: () => Services,
    private readonly im: ImportService
  ) {}

  private get db() {
    return this.s().db;
  }

  registerJobs(): void {
    const s = this.s();
    s.jobs.register('imports.dataset', (p, ctx) => this.run(String(p.importId), ctx), { timeoutMs: 12 * 3_600_000 });
    s.jobs.register('imports.refresh-due', (p, ctx) => this.refreshDue(String(p.tenantId ?? ctx.job.tenant_id)));
    // The Knowledge screen's "Sync now" on a dataset source, and the refresh tick, both end here.
    s.knowledge.datasets = { refresh: (by, source) => this.refresh(by, source) };
  }

  // ---------- describe, preview ----------

  private async datasetRepo(p: Principal, repositoryId: string): Promise<RepositoryRow> {
    const r = await this.im.repositories.active(p.tenantId, repositoryId);
    if (!r.kinds.includes('dataset')) throw conflict(`${r.name} does not offer datasets.`);
    if (!hasDatasetFetch(r.type)) throw conflict(`${REPO_TYPE_INFO[r.type].name} datasets can be browsed but not fetched: the type has no fetch step.`);
    if (this.im.modeFor(r) === 'bundle') throw conflict('This instance is air-gapped: a dataset is not fetched from its source. Datasets arrive as JSON Lines in the training staging area (training/staging/<tenant>/) and are registered under Training.');
    if (this.im.repositories.backingOff(r)) throw new HttpProblem(503, 'Source rate limited', `${r.name} is rate limiting the staging proxy until ${new Date(r.backoff_until!).toISOString()}. Try again then.`, { headers: { 'Retry-After': String(Math.ceil((r.backoff_until! - Date.now()) / 1000)) }, extensions: { backoffUntil: r.backoff_until } });
    return r;
  }

  private async detail(r: RepositoryRow, item: string, signal?: AbortSignal): Promise<DatasetDetail> {
    const d = await describeDataset(this.im.repositories.context(r, signal), item);
    // A source that states no frequency (a hub, an SDMX provider) may have one in the harvested catalogue.
    if (!d.updates) {
      const row = await this.im.catalog.item(r, 'dataset', item).catch(() => null);
      d.updates = row?.facets.updates?.[0] ?? null;
    }
    return d;
  }

  /** The select step: one dataset as the source states it now. */
  async describe(p: Principal, repositoryId: string, item: string) {
    const r = await this.datasetRepo(p, repositoryId);
    try {
      const d = await this.detail(r, item);
      const q = await this.im.quota(p.tenantId);
      return { ...d, source: 'live' as const, licenceAllowed: (await this.im.allowedLicences(p.tenantId)).has(normaliseLicence(d.licence)), quota: { maxBytes: q.maxBytes, usedBytes: q.usedBytes.datasets, maxRows: this.s().cfg.IMPORT_DATASET_MAX_ROWS } };
    } catch (err) {
      throw await this.im.sourceProblem(r, err);
    }
  }

  /** What is fetched of a dataset: the configuration and its splits (a hub), or the resources (everything else). */
  private select(r: RepositoryRow, d: DatasetDetail, input: Pick<DatasetOptions, 'config' | 'splits' | 'resources'>): { config: string | null; splits: string[]; resources: DatasetResource[]; rows: number | null; bytes: number | null; problem: string | null } {
    if (r.type === 'hf') {
      const config = input.config ?? d.configurations[0]?.id ?? null;
      const mine = d.splits.filter((x) => x.config === config);
      if (!config || !mine.length) return { config, splits: [], resources: [], rows: null, bytes: null, problem: config ? `${config} is not a configuration of ${d.itemId}.` : `${d.itemId} lists no configuration the dataset viewer can read.` };
      const splits = input.splits.length ? input.splits : mine.map((x) => x.id);
      const missing = splits.filter((x) => !mine.some((y) => y.id === x));
      const picked = mine.filter((x) => splits.includes(x.id));
      const known = picked.every((x) => x.rows != null);
      return { config, splits, resources: [], rows: known ? picked.reduce((a, x) => a + x.rows!, 0) : null, bytes: picked.every((x) => x.bytes != null) ? picked.reduce((a, x) => a + x.bytes!, 0) : null, problem: missing.length ? `${missing.join(', ')}: not a split of ${config}.` : null };
    }
    const readable = d.resources.filter((x) => x.access !== 'unsupported');
    // Without a choice: the first resource with an API, then the first readable file (a table before an archive or XML).
    const picked = input.resources.length ? d.resources.filter((x) => input.resources.includes(x.id)) : [readable.find((x) => x.access !== 'file') ?? readable.find((x) => x.format !== 'zip' && x.format !== 'xml') ?? readable[0]].filter((x): x is DatasetResource => !!x);
    const bad = picked.find((x) => x.access === 'unsupported');
    const problem = input.resources.length && picked.length !== input.resources.length ? 'A selected resource is not in the dataset now.' : bad ? `${bad.name}: ${bad.note ?? 'the resource cannot be read.'}` : !picked.length ? (d.resources.length ? `None of the ${d.resources.length} resources can be read: ${d.resources[0]!.note ?? ''}` : 'The dataset lists no resources.') : null;
    return { config: r.type === 'sdmx' ? (input.config ?? 'all') : null, splits: [], resources: picked, rows: null, bytes: picked.length && picked.every((x) => x.size != null) ? picked.reduce((a, x) => a + x.size!, 0) : null, problem };
  }

  private async fetchRows(r: RepositoryRow, d: DatasetDetail, sel: ReturnType<DatasetImports['select']>, o: { startPeriod: string | null; endPeriod: string | null; limit: number | null; max: number | null; budget: RowBudget; signal?: AbortSignal; dropColumns?: string[]; onRow?: (n: number) => Promise<void> }): Promise<SourceRecord[]> {
    const out: SourceRecord[] = [];
    const drop = new Set(o.dropColumns ?? []);
    for await (const rec of datasetRows(this.im.repositories.context(r, o.signal), d.itemId, { config: sel.config, splits: sel.splits, resources: sel.resources, startPeriod: o.startPeriod, endPeriod: o.endPeriod, limit: o.limit, budget: o.budget, gated: d.gated })) {
      if (o.signal?.aborted) throw o.signal.reason as Error;
      if (drop.size) for (const c of drop) delete rec.values[c];
      out.push(rec);
      if (o.limit != null && out.length >= o.limit) break;
      if (o.max != null && out.length > o.max) throw new ImportRefused(`The selection has more than ${o.max.toLocaleString('en-US')} rows (IMPORT_DATASET_MAX_ROWS). Request it again with a row limit to import a sample.`, 'quota');
      if (o.onRow && out.length % 1000 === 0) await o.onRow(out.length);
    }
    return out;
  }

  /** The schema preview: the first rows of the selection, with a type, a sample and a PII flag per column. */
  async preview(p: Principal, input: Pick<DatasetInput, 'repositoryId' | 'item' | 'config' | 'splits' | 'resources' | 'startPeriod' | 'endPeriod'> & { rows?: number }) {
    const s = this.s();
    const r = await this.datasetRepo(p, input.repositoryId);
    try {
      const d = await this.detail(r, input.item);
      const sel = this.select(r, d, { config: input.config ?? null, splits: input.splits ?? [], resources: input.resources ?? [] });
      if (sel.problem) throw new HttpProblem(422, 'Nothing to preview', sel.problem);
      const limit = Math.min(input.rows ?? s.cfg.IMPORT_PREVIEW_ROWS, s.cfg.IMPORT_PREVIEW_ROWS);
      const rows = await this.fetchRows(r, d, sel, { startPeriod: input.startPeriod ?? null, endPeriod: input.endPeriod ?? null, limit, max: null, budget: { used: 0, max: Math.min(s.cfg.IMPORT_MAX_BYTES, 256 * 1024 * 1024) } });
      const columns = profile(rows.map((x) => x.values));
      return { item: d.itemId, rows: rows.length, limit, selection: { config: sel.config, splits: sel.splits, resources: sel.resources.map((x) => x.id) }, columns, flagged: columns.filter((c) => c.pii).length, suggested: suggest(columns), sourceIds: rows.some((x) => x.id != null) };
    } catch (err) {
      throw await this.im.sourceProblem(r, err);
    }
  }

  // ---------- plan ----------

  private options(input: DatasetInput): DatasetOptions {
    return { config: input.config ?? null, splits: input.splits ?? [], resources: input.resources ?? [], startPeriod: input.startPeriod ?? null, endPeriod: input.endPeriod ?? null, sample: input.sample?.rows ?? null, dropColumns: [...new Set(input.dropColumns ?? [])] };
  }

  /** The review step: every check and what would be made; nothing is written. */
  async plan(p: Principal, input: DatasetInput, previewRows = 200): Promise<DatasetPlan> {
    const s = this.s();
    // Without a reachable source that has a fetch step there is nothing to check (409, or 503 while it backs off).
    const r = await this.datasetRepo(p, input.repositoryId);
    const checks: Check[] = [];
    const mode = this.im.modeFor(r);
    let d: DatasetDetail;
    let sel: ReturnType<DatasetImports['select']>;
    let columns: ColumnProfile[] = [];
    let sampled = 0;
    const opts = this.options(input);
    try {
      d = await this.detail(r, input.item);
      sel = this.select(r, d, opts);
      if (!sel.problem && !closed(d)) {
        const rows = await this.fetchRows(r, d, sel, { startPeriod: opts.startPeriod, endPeriod: opts.endPeriod, limit: Math.min(previewRows, s.cfg.IMPORT_PREVIEW_ROWS), max: null, budget: { used: 0, max: Math.min(s.cfg.IMPORT_MAX_BYTES, 256 * 1024 * 1024) } });
        sampled = rows.length;
        columns = profile(rows.map((x) => x.values));
      }
    } catch (err) {
      throw await this.im.sourceProblem(r, err);
    }
    // ---- selection
    if (sel.problem) checks.push({ name: 'Selection', result: 'refused', detail: sel.problem });
    else if (!sampled && !closed(d)) checks.push({ name: 'Selection', result: 'refused', detail: 'The selection has no rows.' });
    else checks.push({ name: 'Selection', result: 'passed', detail: r.type === 'hf' ? `Configuration ${sel.config}, ${sel.splits.length === 1 ? 'split' : 'splits'} ${sel.splits.join(', ')}.` : `${sel.resources.map((x) => `${x.name} (${x.access === 'file' ? x.format : x.note ?? x.access})`).join('; ')}${sel.config && sel.config !== 'all' ? `; series ${sel.config}` : ''}${opts.startPeriod || opts.endPeriod ? `; ${opts.startPeriod ?? 'start'} to ${opts.endPeriod ?? 'now'}` : ''}.` });
    // ---- size and quota
    const q = await this.im.quota(p.tenantId);
    const left = Math.max(0, q.maxBytes - q.usedBytes.datasets);
    const maxRows = s.cfg.IMPORT_DATASET_MAX_ROWS;
    const cap = input.target === 'classifiers' ? Math.min(maxRows, MAX_CASES) : input.target === 'knowledge' && !input.knowledge?.groupBy ? Math.min(maxRows, s.cfg.IMPORT_KNOWLEDGE_MAX_DOCS) : maxRows;
    const capName = cap === maxRows ? `${maxRows.toLocaleString('en-US')} rows an import keeps (IMPORT_DATASET_MAX_ROWS)` : input.target === 'classifiers' ? `${MAX_CASES.toLocaleString('en-US')} cases an eval set is read with` : `${cap.toLocaleString('en-US')} documents a knowledge set holds (IMPORT_KNOWLEDGE_MAX_DOCS)`;
    const n = (v: number) => v.toLocaleString('en-US');
    if (opts.sample != null && opts.sample > cap) checks.push({ name: 'Size and quota', result: 'refused', detail: `A row limit of ${n(opts.sample)} is above the ${capName}.` });
    else if (opts.sample != null) checks.push({ name: 'Size and quota', result: 'warning', detail: `A sample is imported: the first ${n(opts.sample)} rows in publication order${sel.rows != null ? `, of ${n(sel.rows)}` : ''}. It still counts against the ${n(left)} bytes of dataset quota left.` });
    else if (sel.bytes != null && sel.bytes > left) checks.push({ name: 'Size and quota', result: 'refused', detail: `${n(sel.bytes)} bytes selected against ${n(left)} bytes left of a ${n(q.maxBytes)} byte dataset quota. Import a sample (a row limit) or a smaller configuration.` });
    else if (sel.rows != null && sel.rows > cap) checks.push({ name: 'Size and quota', result: 'refused', detail: `${n(sel.rows)} rows selected, above the ${capName}. Import a sample (a row limit)${input.target === 'knowledge' ? ' or group the rows by a column' : ''}.` });
    else if (sel.bytes != null) checks.push({ name: 'Size and quota', result: 'passed', detail: `${n(sel.bytes)} bytes${sel.rows != null ? `, ${n(sel.rows)} rows` : ''}; ${n(left)} bytes of dataset quota left.` });
    else checks.push({ name: 'Size and quota', result: 'info', detail: `The source states no size${sel.rows != null ? ` (${n(sel.rows)} rows)` : ''}. The import stops if it passes the ${n(left)} bytes of quota left or the ${capName}.` });
    // ---- licence (the model import's policy)
    const allowed = await this.im.allowedLicences(p.tenantId);
    const sourceLicence = normaliseLicence(d.licence);
    const unknown = sourceLicence === 'unknown' || sourceLicence === 'other';
    const recorded = unknown && !!input.licence;
    const licence = recorded ? normaliseLicence(input.licence) : sourceLicence;
    const licenceAllowed = allowed.has(licence);
    const needsException = !licenceAllowed && !(unknown && !input.licence);
    if (unknown && !input.licence) checks.push({ name: 'Licence', result: 'waiting', detail: `The source states no recognised licence (${d.licenceSource}). Record it; anything outside the tenant's allow-list waits for legal review.` });
    else if (licenceAllowed) checks.push({ name: 'Licence', result: 'passed', detail: `${licence}, read from ${recorded ? 'the requester (recorded by hand)' : d.licenceSource}; on the tenant's allow-list.` });
    else checks.push({ name: 'Licence', result: 'waiting', detail: `${licence} is outside the tenant's allow-list. The import waits in the queue for a licence exception decided by the legal-review role.` });
    // ---- access
    if (closed(d)) checks.push({ name: 'Access', result: 'refused', detail: 'The dataset is gated and the hub lists no files of it for the repository\'s token. Record a token for the repository and accept the dataset\'s terms on the hub with that account; the rows are then read from the hub itself (the dataset viewer never receives the token).' });
    else if (d.gated) checks.push({ name: 'Access', result: 'passed', detail: 'The dataset is gated; the recorded token reads its Parquet files from the hub itself.' });
    // ---- PII preview
    const flagged = columns.filter((c) => c.pii && !opts.dropColumns.includes(c.name));
    const dropped = opts.dropColumns.filter((c) => columns.some((x) => x.name === c));
    const unknownDrop = opts.dropColumns.filter((c) => !columns.some((x) => x.name === c));
    if (sampled) {
      const scrub = input.target === 'store' ? 'Store only keeps the rows as published: nothing is masked.' : 'The scrub masks what the detectors find before rows are stored; the report is on the manifest.';
      checks.push(flagged.length ? { name: 'PII preview', result: 'warning', detail: `${flagged.length} column${flagged.length > 1 ? 's' : ''} flagged in the first ${n(sampled)} rows: ${flagged.slice(0, 8).map((c) => `${c.name} (${c.pii})`).join('; ')}. ${scrub}${dropped.length ? ` Dropped: ${dropped.join(', ')}.` : ''}` } : { name: 'PII preview', result: 'passed', detail: `Nothing flagged in the first ${n(sampled)} rows.${dropped.length ? ` Dropped: ${dropped.join(', ')}.` : ''} ${input.target === 'store' ? '' : 'The full scrub still runs.'}`.trim() });
      if (unknownDrop.length) checks.push({ name: 'PII preview', result: 'refused', detail: `${unknownDrop.join(', ')}: not a column of the selection, so it cannot be dropped.` });
    }
    // ---- refresh
    const cadence = input.target === 'knowledge' ? cadenceOf(input.knowledge?.refresh ?? 'manual', d.updates) : null;
    if (input.target === 'knowledge' && (input.knowledge?.refresh ?? 'manual') !== 'manual') checks.push(cadence ? { name: 'Refresh', result: 'info', detail: `Refreshed ${cadence}${input.knowledge?.refresh === 'publisher' ? ' (the publisher\'s stated frequency)' : ''}: the rows are fetched and scrubbed again and the documents that changed are re-indexed.` } : { name: 'Refresh', result: 'warning', detail: `The publisher states no update frequency${d.updates ? ` the schedule understands (${d.updates})` : ''}, so there is nothing to follow: the knowledge set is refreshed by hand until a schedule is chosen.` });
    else checks.push({ name: 'Refresh', result: 'info', detail: d.updates && d.updates !== 'static' ? `The publisher updates ${d.updates}. ${input.target === 'knowledge' ? 'No schedule is set: the knowledge set is refreshed by hand.' : 'This import is one fetch; import again for a newer version.'}` : 'The publisher states no updates. One import, no schedule.' });
    // ---- destination
    const dest = await this.destination(p, input, columns, sampled > 0);
    checks.push(dest.check);
    // ---- connectivity
    checks.push(r.status === 'rate limited' ? { name: 'Connectivity', result: 'warning', detail: `${r.name} was rate limiting the staging proxy; the fetch queues with backoff.` } : { name: 'Connectivity', result: 'passed', detail: `Through ${this.im.fetcher.viaProxy ? 'the staging proxy' : 'the import egress'}, allow-listed hosts only (${[r.host, ...r.extra_hosts].slice(0, 4).join(', ')}).` });
    return {
      repository: { id: r.id, name: r.name, type: r.type },
      item: d.itemId,
      name: d.name,
      revision: d.revision,
      mode,
      target: input.target,
      selection: { config: sel.config, splits: sel.splits, resources: sel.resources.map((x) => ({ id: x.id, name: x.name, format: x.format, access: x.access })) },
      rows: sel.rows,
      sizeBytes: sel.bytes,
      sample: opts.sample,
      updates: d.updates,
      licence: { id: licence, source: recorded ? 'recorded by the requester' : d.licenceSource, allowed: licenceAllowed, recorded, needsException },
      label: input.label,
      creates: dest.creates,
      columns,
      previewRows: sampled,
      checks,
      blocked: checks.some((c) => c.result === 'refused'),
      waiting: checks.some((c) => c.result === 'waiting')
    };
  }

  /** The destination check: the permission of the place the rows go to, its name and the mapped columns. */
  private async destination(p: Principal, input: DatasetInput, columns: ColumnProfile[], sampled: boolean): Promise<{ check: Check; creates: string }> {
    const s = this.s();
    const refuse = (detail: string, creates = TARGET_NAMES[input.target]): { check: Check; creates: string } => ({ check: { name: 'Destination', result: 'refused', detail }, creates });
    const need = TARGET_PERMISSION[input.target];
    if (need && !effectivePermissions(p).has(need as never)) return refuse(`A ${TARGET_NAMES[input.target].toLowerCase()} needs ${need} as well as imports:run.`);
    if (!clears(p.clearance, input.label)) return refuse(`Your clearance does not reach ${input.label}.`);
    const dropped = new Set(input.dropColumns ?? []);
    const missing = (cols: (string | null | undefined)[]) => (sampled ? cols.filter((c): c is string => !!c && (dropped.has(c) || !columns.some((x) => x.name === c))) : []);
    const noColumn = (cols: (string | null | undefined)[]) => {
      const m = missing(cols);
      return m.length ? `${m.join(', ')}: ${m.length > 1 ? 'not columns' : 'not a column'} of the selection${m.some((c) => dropped.has(c)) ? ' (or dropped)' : ''}. It has ${columns.map((c) => c.name).slice(0, 12).join(', ')}.` : null;
    };
    if (input.target === 'training') {
      const t = input.training;
      if (!t) return refuse('Name the training dataset (training: { name }).');
      if (!NAME63.test(t.name)) return refuse(`${t.name.slice(0, 80)} is not a dataset name: lower-case letters, digits, dot, dash and underscore, up to 63.`);
      const bad = noColumn([t.promptColumn, t.completionColumn]);
      if (bad) return refuse(bad);
      if (t.completionColumn && !t.promptColumn) return refuse('A completion column needs a prompt column.');
      const have = new Set(columns.map((c) => c.name));
      const shaped = (have.has('prompt') && have.has('completion')) || (have.has('instruction') && have.has('output')) || have.has('messages') || have.has('text');
      if (sampled && !t.promptColumn && !shaped) return refuse('Pick the prompt or text column: the rows have no prompt and completion, instruction and output, messages or text of their own.');
      const sp = t.splits ?? { train: 80, val: 10, test: 10 };
      if (sp.train + sp.val + sp.test !== 100) return refuse('The splits must add up to 100.');
      const last = Number(((await this.db('training_datasets').where({ tenant_id: p.tenantId, name: t.name }).max({ v: 'version' }))[0] as { v: unknown } | undefined)?.v ?? 0);
      const creates = `Training dataset ${t.name} v${last + 1}`;
      return { check: { name: 'Destination', result: 'passed', detail: `${creates}: ${t.promptColumn ? (t.completionColumn ? `${t.promptColumn} as the prompt, ${t.completionColumn} as the completion` : `${t.promptColumn} as the text`) : 'the rows as published'}, split ${sp.train} / ${sp.val} / ${sp.test}, scrubbed and hashed.` }, creates };
    }
    if (input.target === 'classifiers') {
      const c = input.classifier;
      if (!c) return refuse('Name the classifier and the text and label columns.');
      const bad = noColumn([c.textColumn, c.labelColumn]);
      if (bad) return refuse(bad);
      const labelCol = columns.find((x) => x.name === c.labelColumn);
      if (c.classifierId) {
        const have = await s.guard.classifiers.get(p.tenantId, c.classifierId);
        if (!have) return refuse('The classifier does not exist.');
        if (have.tenant_id === null) return refuse(`${have.name} is a platform classifier; its eval set is not a tenant's to change.`);
        if (have.engine === 'vision') return refuse(`${have.name} classifies images; an imported dataset gives text cases.`);
        const creates = `Classifier eval set: ${have.name} (${have.dataset ?? `${have.slug}-eval`})`;
        return { check: { name: 'Destination', result: 'passed', detail: `${c.mode === 'replace' ? 'Replaces' : 'Adds to'} the eval set ${have.dataset ?? `${have.slug}-eval`} of ${have.name}. Rows whose label is not one of ${have.config.labels.map((l) => l.label).slice(0, 8).join(', ')} are left out.` }, creates };
      }
      const name = (c.name ?? '').trim();
      if (!name) return refuse('Name the new classifier, or pick an existing one.');
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 63);
      if (!slug) return refuse('The classifier name needs letters or digits.');
      if (await s.guard.classifiers.get(p.tenantId, slug)) return refuse(`A classifier named ${slug} exists. Pick it as the destination, or choose another name.`);
      const engine = c.engine ?? 'linear';
      if (engine !== 'linear' && !c.profile) return refuse('A model-based classifier needs the profile that routes to its model.');
      if (labelCol && !labelCol.type.startsWith('class') && sampled) return { check: { name: 'Destination', result: 'warning', detail: `New classifier ${name}. ${c.labelColumn} does not look like a label column in the preview (${labelCol.type}); a classifier takes at most ${MAX_LABELS} labels, and the import is refused if the rows have more.` }, creates: `Classifier eval set: new classifier ${name}` };
      return { check: { name: 'Destination', result: 'passed', detail: `New draft classifier ${name} (${engine}), its labels from ${c.labelColumn} and its eval set from the rows. Labels below ${c.minPerLabel ?? MIN_SAMPLES} samples are reported.` }, creates: `Classifier eval set: new classifier ${name}` };
    }
    if (input.target === 'knowledge') {
      const k = input.knowledge;
      if (!k || !k.textColumns?.length) return refuse('Pick the text columns of the knowledge set.');
      const bad = noColumn([k.titleColumn, ...k.textColumns, ...(k.metadataColumns ?? []), k.idColumn, k.groupBy]);
      if (bad) return refuse(bad);
      if (k.knowledgeBaseId) {
        let kb;
        try {
          kb = await s.knowledge.base(p, k.knowledgeBaseId, 'manage');
        } catch (err) {
          return refuse(err instanceof HttpProblem ? (err.detail ?? err.message) : (err as Error).message);
        }
        return { check: { name: 'Destination', result: 'passed', detail: `A dataset source on the knowledge base ${kb.name}, documents at ${highest(kb.label, input.label)} or above.` }, creates: `Knowledge set: ${kb.name}` };
      }
      const name = (k.name ?? '').trim();
      if (!name) return refuse('Name the knowledge set, or pick an existing knowledge base.');
      if (!k.embedModel) return refuse('Pick the embedding model of the new knowledge base.');
      const m = await s.gateway.repo.modelByName(k.embedModel);
      if (!m || !m.capabilities.includes('embedding') || (m.state !== 'approved' && m.state !== 'deprecated')) return refuse(`${k.embedModel} is not an approved embedding model in the catalogue.`);
      return { check: { name: 'Destination', result: 'passed', detail: `New knowledge base ${name} (${input.label}, ${k.embedModel}) with one source of kind dataset: ${k.groupBy ? `one document per ${k.groupBy}` : 'one document per row'}, citations back to the row.` }, creates: `Knowledge set: ${name}` };
    }
    const st = input.store;
    if (!st || !NAME63.test(st.name)) return refuse(st ? `${st.name.slice(0, 80)} is not a dataset name: lower-case letters, digits, dot, dash and underscore, up to 63.` : 'Name the stored dataset (store: { name }).');
    return { check: { name: 'Destination', result: 'passed', detail: `Stored sealed as ${st.name} with its manifest and hash${st.retentionDays ? `, deleted after ${st.retentionDays} days` : ''}. Nothing is scrubbed or indexed.` }, creates: `Dataset store: ${st.name}` };
  }

  // ---------- requests ----------

  async request(p: Principal, input: DatasetInput, traceId?: string | null) {
    const s = this.s();
    if (!clears(p.clearance, input.label)) throw forbidden('You cannot import for data above your clearance.', { step: 'clearance' });
    const need = TARGET_PERMISSION[input.target];
    if (need && !effectivePermissions(p).has(need as never)) throw forbidden(`A ${TARGET_NAMES[input.target].toLowerCase()} needs ${need} as well as imports:run.`, { step: 'role', action: need });
    const plan = await this.plan(p, input);
    const r = await this.im.repositories.get(p.tenantId, input.repositoryId);
    const t = Date.now();
    const options = this.options(input);
    options.splits = plan.selection.splits;
    options.resources = plan.selection.resources.map((x) => x.id);
    options.config = plan.selection.config;
    if (input.target === 'training') options.training = { name: input.training!.name, promptColumn: input.training!.promptColumn ?? null, completionColumn: input.training!.completionColumn ?? null, splits: input.training!.splits ?? { train: 80, val: 10, test: 10 } };
    if (input.target === 'classifiers') options.classifier = { classifierId: input.classifier!.classifierId ?? null, name: input.classifier!.name ?? null, engine: input.classifier!.engine ?? 'linear', profile: input.classifier!.profile ?? null, textColumn: input.classifier!.textColumn, labelColumn: input.classifier!.labelColumn, mode: input.classifier!.mode ?? 'add', minPerLabel: input.classifier!.minPerLabel ?? MIN_SAMPLES, evaluate: input.classifier!.evaluate ?? true };
    if (input.target === 'store') options.store = { name: input.store!.name, retentionDays: input.store!.retentionDays ?? null };
    const base = {
      id: ulid(),
      tenant_id: p.tenantId,
      workspace_id: input.workspaceId ?? p.workspaceId ?? null,
      kind: 'dataset',
      repository_id: r.id,
      item_id: plan.item.slice(0, 300),
      item_name: plan.name.slice(0, 400),
      revision: plan.revision?.slice(0, 100) ?? null,
      target: input.target,
      mode: 'direct',
      progress: 0,
      checks: JSON.stringify(plan.checks),
      licence: plan.licence.id,
      label: input.label,
      attribution: input.attribution ?? null,
      size_bytes: plan.sizeBytes ?? 0,
      stored_bytes: 0,
      files: '[]',
      manifest: null,
      requested_by: p.userId,
      created_at: t,
      updated_at: t
    };
    const prefix = `IMP-${new Date(t).getUTCFullYear()}-`;
    if (plan.blocked) {
      const refused = plan.checks.filter((c) => c.result === 'refused');
      const ref = await this.im.insertWithRef(p.tenantId, 'import_jobs', prefix, { ...base, state: 'refused', stage: null, note: refused[0]!.detail.slice(0, 500), options: JSON.stringify(options), log: JSON.stringify([{ at: t, title: 'Refused', meta: refused.map((c) => `${c.name}: ${c.detail}`).join(' ').slice(0, 1000), tone: 'danger' }]), licence_status: 'allowed', finished_at: t, error: refused.map((c) => c.detail).join(' ').slice(0, 1000) });
      await this.im.audit(p, p.tenantId, 'import.refused', { import: base.id, ref, repository: r.id, item: plan.item }, { checks: refused, revision: plan.revision, target: input.target }, input.label, traceId);
      throw new HttpProblem(422, 'Import refused', refused.map((c) => c.detail).join(' '), { extensions: { import: await this.im.view(p.tenantId, (await this.im.row(p.tenantId, base.id))!), checks: plan.checks, reason: refused.map((c) => c.name.toLowerCase()) } });
    }
    const unknownLicence = !plan.licence.needsException && !plan.licence.allowed;
    if (unknownLicence) throw new HttpProblem(409, 'Licence not recorded', 'The source states no recognised licence. Record it (`licence`) to continue; outside the allow-list it then waits for legal review.', { extensions: { reason: 'licence-unknown' } });
    if (plan.licence.needsException && !input.exception) throw new HttpProblem(409, 'Licence exception required', `${plan.licence.id} is outside the tenant's allow-list. Request an exception (\`exception: {reason}\`); the import then waits for the legal-review role to decide.`, { extensions: { reason: 'licence-exception-required', licence: plan.licence.id } });
    // A knowledge set's base and source exist from the request on (as the requester, who must manage the base); the
    // source stays empty, and is not refreshed, until this import has run with its licence cleared.
    if (input.target === 'knowledge') {
      const k = input.knowledge!;
      const kb = k.knowledgeBaseId ? await s.knowledge.base(p, k.knowledgeBaseId, 'manage') : await s.knowledge.create(p, { name: k.name!.trim(), description: `Imported from ${r.name}: ${plan.name}`.slice(0, 500), label: input.label, embedModel: k.embedModel!, reranker: null, sharing: 'members', workspaceId: k.workspaceId ?? null });
      const refresh = k.refresh ?? 'manual';
      const dataset: DatasetSourceConfig = { repositoryId: r.id, item: plan.item, name: plan.name, config: options.config, splits: options.splits, resources: options.resources, startPeriod: options.startPeriod, endPeriod: options.endPeriod, sample: options.sample, dropColumns: options.dropColumns, titleColumn: k.titleColumn ?? null, textColumns: k.textColumns, metadataColumns: (k.metadataColumns ?? []).filter((c) => !k.textColumns.includes(c)), idColumn: k.idColumn ?? null, groupBy: k.groupBy ?? null, refresh, cadence: cadenceOf(refresh, plan.updates), nextRefreshAt: null, licence: plan.licence.id, licenceStatus: 'pending', attribution: input.attribution ?? null, lastImport: null, lastRows: null, lastHash: null };
      const src = await s.knowledge.addDatasetSource(p, kb.id, { location: `${r.name}: ${plan.name}`, labelFloor: input.label, dataset });
      options.knowledge = { kbId: kb.id, sourceId: src.id, name: kb.name, createdBase: !k.knowledgeBaseId };
    }
    const state: ImportState = plan.licence.needsException ? 'waiting on licence' : 'queued';
    const licenceStatus: LicenceStatus = plan.licence.needsException ? 'exception pending' : 'allowed';
    const log: LogEntry[] = [{ at: t, title: 'Request accepted', meta: `${plan.licence.id} read from ${plan.licence.source}${plan.revision ? `; revision ${plan.revision.slice(0, 40)}` : ''}; creates ${plan.creates}`, tone: 'ok' }];
    const ref = await this.im.insertWithRef(p.tenantId, 'import_jobs', prefix, { ...base, state, stage: null, note: state === 'waiting on licence' ? `${plan.licence.id} is outside the tenant policy; waiting on legal review` : null, options: JSON.stringify(options), log: JSON.stringify(log), licence_status: licenceStatus, finished_at: null, error: null });
    await this.im.audit(p, p.tenantId, 'import.requested', { import: base.id, ref, repository: r.id, item: plan.item }, { kind: 'dataset', target: input.target, creates: plan.creates, revision: plan.revision, licence: plan.licence, label: input.label, selection: plan.selection, sample: options.sample, state }, input.label, traceId);
    if (state === 'waiting on licence') {
      const excRef = await this.im.insertWithRef(p.tenantId, 'import_exceptions', 'EXC-', { id: ulid(), tenant_id: p.tenantId, import_id: base.id, licence: plan.licence.id, reason: input.exception?.reason ?? null, state: 'pending', requested_by: p.userId, requested_at: t, decided_by: null, decided_at: null, decision_note: null });
      await this.im.appendLog(base.id, { at: t, title: 'Licence exception requested', meta: `${excRef}: ${plan.licence.id}`, tone: 'warn' });
      await this.im.audit(p, p.tenantId, 'import.exception.requested', { import: base.id, ref, exception: excRef }, { licence: plan.licence.id, reason: input.exception?.reason ?? null }, input.label, traceId);
      const reviewers = (await s.notifications.usersWithRoles(p.tenantId, rolesGranting('imports:review', p.tenantId).filter((x) => x !== 'system-admin'))).filter((u) => u !== p.userId);
      await this.im.notifyUsers(p.tenantId, reviewers, 'Licence exception to decide', `${p.displayName} asks to import ${plan.name} under ${plan.licence.id}, which is outside the tenant's allow-list (${excRef}, ${ref}).`, input.label, 'import.exception');
    } else await this.im.enqueue(p.tenantId, base.id, p.userId);
    return this.im.view(p.tenantId, (await this.im.row(p.tenantId, base.id))!);
  }

  /** A cancelled import that never ran leaves no empty source behind when the canceller may remove it. */
  async abandoned(p: Principal, r: ImportRow): Promise<void> {
    const o = r.options as unknown as DatasetOptions;
    if (r.target !== 'knowledge' || !o.knowledge || o.refreshOf || r.started_at) return;
    try {
      await this.s().knowledge.removeSource(p, o.knowledge.sourceId);
      await this.im.appendLog(r.id, { at: Date.now(), title: 'Source removed', meta: `the empty dataset source of ${o.knowledge.name}`, tone: '' });
    } catch {
      // Without manage access the empty source stays; it is never refreshed while its licence status is pending.
    }
  }

  // ---------- refresh (B-3805) ----------

  /** Queues a refresh of a dataset source as an import of its own, so the queue shows it with its log. */
  async refresh(by: string | null, source: SourceRow): Promise<{ jobId: string }> {
    const cfg = source.config.dataset;
    if (!cfg) throw conflict('The source has no dataset settings; remove it and import the dataset again.');
    if (cfg.licenceStatus !== 'allowed' && cfg.licenceStatus !== 'exception granted') throw conflict('This source\'s first import has not completed (or its licence was not cleared), so there is nothing to refresh. See the Imports queue.');
    const repo = await this.im.repositories.get(source.tenant_id, cfg.repositoryId).catch(() => null);
    const kb = (await this.db('knowledge_bases').where({ id: source.kb_id }).first('name')) as { name: string } | undefined;
    const t = Date.now();
    const id = ulid();
    const options: DatasetOptions = { config: cfg.config, splits: cfg.splits, resources: cfg.resources, startPeriod: cfg.startPeriod, endPeriod: cfg.endPeriod, sample: cfg.sample, dropColumns: cfg.dropColumns, knowledge: { kbId: source.kb_id, sourceId: source.id, name: kb?.name ?? '', createdBase: false }, refreshOf: source.id };
    const requester = by ?? source.created_by ?? '';
    const ref = await this.im.insertWithRef(source.tenant_id, 'import_jobs', `IMP-${new Date(t).getUTCFullYear()}-`, { id, tenant_id: source.tenant_id, workspace_id: null, kind: 'dataset', repository_id: cfg.repositoryId, item_id: cfg.item.slice(0, 300), item_name: cfg.name.slice(0, 400), revision: null, target: 'knowledge', mode: 'direct', state: 'queued', stage: null, progress: 0, note: by ? 'Refresh' : `Scheduled refresh${cfg.cadence ? `, ${cfg.cadence}` : ''}`, files: '[]', options: JSON.stringify(options), checks: '[]', log: JSON.stringify([{ at: t, title: by ? 'Refresh requested' : 'Refresh due', meta: `${cfg.refresh === 'publisher' ? 'following the publisher' : cfg.refresh}${repo ? `; ${repo.name}` : ''}`, tone: '' }]), manifest: null, licence: cfg.licence, licence_status: cfg.licenceStatus, label: source.label_floor, attribution: cfg.attribution, size_bytes: 0, stored_bytes: 0, requested_by: requester, created_at: t, updated_at: t, finished_at: null, error: null });
    await this.im.audit(null, source.tenant_id, 'import.refresh.requested', { import: id, ref, source: source.id, knowledgeBase: source.kb_id }, { by: by ?? 'schedule', cadence: cfg.cadence, item: cfg.item }, source.label_floor);
    return { jobId: await this.im.enqueue(source.tenant_id, id, by) };
  }

  /** Scheduled: dataset sources whose refresh is due, and stored datasets past their retention. */
  async refreshDue(tenantId: string): Promise<{ queued: number; purged: number }> {
    const s = this.s();
    const now = Date.now();
    let queued = 0;
    for (const src of await s.knowledge.datasetSources(tenantId)) {
      const cfg = src.config.dataset;
      if (!cfg?.nextRefreshAt || cfg.nextRefreshAt > now || src.state === 'syncing') continue;
      try {
        await s.knowledge.sync(null, src);
        queued++;
      } catch (err) {
        s.log.warn({ source: src.id, err: (err as Error).message }, 'dataset refresh not queued');
      }
    }
    let purged = 0;
    const stored = ((await this.db('import_jobs').where({ tenant_id: tenantId, kind: 'dataset', target: 'store', state: 'complete' }).andWhere('stored_bytes', '>', 0)) as Record<string, unknown>[]).map((x) => ({ id: String(x.id), ref: String(x.ref), label: x.label as Label, result: JSON.parse(String(x.result ?? '{}')) as { store?: { key?: string; retainUntil?: number | null } } }));
    for (const x of stored) {
      const until = x.result.store?.retainUntil;
      if (!until || until > now || !x.result.store?.key) continue;
      await s.blobs.delete(x.result.store.key).catch(() => undefined);
      await this.im.update(x.id, { stored_bytes: 0, note: 'The stored rows were deleted at the end of their retention' });
      await this.im.appendLog(x.id, { at: now, title: 'Retention ended', meta: 'the stored rows were deleted; the manifest stays', tone: '' });
      await this.im.audit(null, tenantId, 'import.store.purged', { import: x.id, ref: x.ref }, { retainUntil: until }, x.label);
      purged++;
    }
    return { queued, purged };
  }

  // ---------- the import job ----------

  async run(importId: string, ctx: JobContext): Promise<unknown> {
    const s = this.s();
    const raw = await this.db('import_jobs').where({ id: importId }).first();
    if (!raw) return { skipped: 'gone' };
    const r = (await this.im.row(String(raw.tenant_id), importId))!;
    if (r.state !== 'queued' && r.state !== 'running') return { skipped: r.state };
    const o = r.options as unknown as DatasetOptions;
    const repo = await this.im.repositories.get(r.tenant_id, r.repository_id).catch(() => null);
    const source = o.knowledge ? await s.knowledge.source(r.tenant_id, o.knowledge.sourceId).catch(() => null) : null;
    const fail = async (err: unknown) => {
      const fresh = (await this.im.row(r.tenant_id, r.id))!;
      if (fresh.state === 'cancelled') {
        if (source?.config.dataset && o.refreshOf) await s.knowledge.settleDataset(source, { dataset: source.config.dataset, error: 'The refresh was cancelled.' });
        return { cancelled: true };
      }
      if (err instanceof RateLimited && repo) {
        const until = await this.im.repositories.markRateLimited(repo, err);
        await this.im.update(r.id, { state: 'queued', stage: 'Waiting on the source', note: `${repo.name} is rate limiting; resumes at ${new Date(until).toISOString()}` });
        await this.im.appendLog(r.id, { at: Date.now(), title: 'Rate limited', meta: `backing off until ${new Date(until).toISOString()}`, tone: 'warn' });
        await this.im.enqueue(r.tenant_id, r.id, r.requested_by, until);
        return { rateLimited: until };
      }
      const refused = err instanceof ImportRefused;
      const msg = (err as Error).message.slice(0, 1000);
      await this.im.update(r.id, { state: refused ? 'refused' : 'failed', stage: null, note: msg.slice(0, 500), error: msg, finished_at: Date.now() });
      await this.im.appendLog(r.id, { at: Date.now(), title: refused ? 'Refused' : 'Failed', meta: msg, tone: 'danger' });
      // A failed refresh keeps the documents of the last good one, and is tried again the next day.
      if (source?.config.dataset) await s.knowledge.settleDataset(source, { dataset: { ...source.config.dataset, ...(o.refreshOf && source.config.dataset.cadence ? { nextRefreshAt: Date.now() + 24 * 3_600_000 } : {}) }, error: msg });
      await this.im.audit(null, r.tenant_id, refused ? 'import.refused' : 'import.failed', { import: r.id, ref: r.ref }, { error: msg, ...(refused ? { reason: (err as ImportRefused).reason } : {}) }, r.label);
      if (r.requested_by) await this.im.notifyUsers(r.tenant_id, [r.requested_by], o.refreshOf ? `Refresh ${r.ref} of ${o.knowledge?.name ?? r.item_name} failed` : refused ? `Import ${r.ref} refused` : `Import ${r.ref} failed`, o.refreshOf ? `${msg} The knowledge set keeps the rows of its last good refresh.` : msg, r.label);
      throw err instanceof Error ? err : new Error(String(err));
    };
    try {
      if (!repo) throw new Error('The repository was deleted.');
      if (repo.state !== 'active') throw new Error(`${repo.name} is ${repo.state}; new imports and refreshes from it are refused.`);
      if (!hasDatasetFetch(repo.type)) throw new ImportRefused(`${REPO_TYPE_INFO[repo.type].name} datasets cannot be fetched.`, 'format');
      if (r.target === 'knowledge' && !source) throw new Error('The knowledge source this import fills was removed. Request the import again.');
      await this.im.update(r.id, { state: 'running', stage: 'Reading the source', started_at: r.started_at ?? Date.now(), error: null });
      await ctx.progress(2, 'Reading the source');
      const d = await this.detail(repo, r.item_id, ctx.signal);
      if (closed(d)) throw new ImportRefused('The dataset is gated now and the hub lists no files of it for the repository\'s token.', 'access');
      const fetched = normaliseLicence(d.licence);
      if (fetched !== 'unknown' && fetched !== 'other' && fetched !== r.licence && r.licence_status === 'allowed' && !(await this.im.allowedLicences(r.tenant_id)).has(fetched)) throw new ImportRefused(`The source now states the licence ${fetched}, not ${r.licence}, and it is outside the tenant's allow-list. Request the import again.`, 'licence');
      const sel = this.select(repo, d, o);
      if (sel.problem) throw new ImportRefused(sel.problem, 'selection');
      if (r.revision && d.revision && d.revision !== r.revision) await this.im.appendLog(r.id, { at: Date.now(), title: 'The source moved on', meta: `revision ${r.revision.slice(0, 40)} at request time, ${d.revision.slice(0, 40)} now; the manifest records what was fetched`, tone: 'warn' });
      // ---- fetch
      const q = await this.im.quota(r.tenant_id);
      // A refresh replaces the rows of the last one, whose bytes are released when this one completes.
      const mine = o.refreshOf ? await this.supersededBytes(r.tenant_id, o.refreshOf) : 0;
      const left = Math.max(0, q.maxBytes - q.usedBytes.datasets + mine);
      const budget: RowBudget = { used: 0, max: Math.min(s.cfg.IMPORT_MAX_BYTES, left) };
      if (left <= 0) throw new ImportRefused('The tenant has no dataset import quota left.', 'quota');
      const cap = r.target === 'classifiers' ? Math.min(s.cfg.IMPORT_DATASET_MAX_ROWS, MAX_CASES) : s.cfg.IMPORT_DATASET_MAX_ROWS;
      await this.im.update(r.id, { stage: 'Fetching' });
      const expect = o.sample ?? sel.rows;
      const rows = await this.fetchRows(repo, d, sel, { startPeriod: o.startPeriod, endPeriod: o.endPeriod, limit: o.sample, max: cap, budget, signal: ctx.signal, dropColumns: o.dropColumns, onRow: (n) => ctx.progress(expect ? 5 + Math.min(55, (n / expect) * 55) : Math.min(60, 5 + n / 2000), `${n.toLocaleString('en-US')} rows fetched`) });
      if (!rows.length) throw new ImportRefused('The selection has no rows.', 'selection');
      await this.im.repositories.markOk(repo, `Fetched ${rows.length.toLocaleString('en-US')} rows of ${r.item_id}.`);
      await this.im.appendLog(r.id, { at: Date.now(), title: o.sample ? 'Sample fetched' : 'Fetched', meta: `${rows.length.toLocaleString('en-US')} rows, ${budget.used.toLocaleString('en-US')} bytes from ${repo.name}${o.sample ? ` (the first ${o.sample.toLocaleString('en-US')} in publication order)` : ''}${o.dropColumns.length ? `; dropped ${o.dropColumns.join(', ')}` : ''}`, tone: 'ok' });
      await ctx.progress(62, 'Scrubbing');
      await this.im.update(r.id, { stage: 'Scrubbing' });
      // ---- deliver
      const out = r.target === 'training' ? await this.toTraining(r, o, repo, rows) : r.target === 'classifiers' ? await this.toClassifier(r, o, rows) : r.target === 'knowledge' ? await this.toKnowledge(r, o, repo, d, source!, rows, ctx) : await this.toStore(r, o, rows);
      await this.im.appendLog(r.id, { at: Date.now(), title: out.scrub ? 'PII scrub' : 'Not scrubbed', meta: out.scrub ? (out.scrub.masked ? `${out.scrub.masked.toLocaleString('en-US')} findings masked in ${out.scrub.rowsAffected.toLocaleString('en-US')} rows (${Object.entries(out.scrub.byKind).map(([k, v]) => `${k} ${v}`).join(', ')}); report on the manifest` : 'nothing to mask; report on the manifest') : 'Store only keeps the rows as published', tone: out.scrub ? 'ok' : '' });
      // ---- manifest
      const user = r.requested_by ? await this.db('users').where({ id: r.requested_by }).first('username') : null;
      const manifest: Record<string, unknown> = {
        format: 'exprsn-import-manifest/1',
        import: r.ref,
        kind: 'dataset',
        source: { repository: repo.name, type: repo.type, baseUrl: repo.base_url, item: r.item_id, revision: d.revision, config: sel.config, splits: sel.splits, resources: sel.resources.map((x) => ({ id: x.id, name: x.name, format: x.format, access: x.access })), period: o.startPeriod || o.endPeriod ? { start: o.startPeriod, end: o.endPeriod } : null },
        rows: { fetched: rows.length, kept: out.kept, left: rows.length - out.kept, sampled: o.sample != null, limit: o.sample, droppedColumns: o.dropColumns },
        hash: out.hash,
        scrub: out.scrub,
        licence: { id: r.licence, source: d.licenceSource, status: r.licence_status },
        label: r.label,
        attribution: r.attribution,
        requester: { id: r.requested_by, username: (user?.username as string | undefined) ?? null },
        destination: out.result,
        registeredAt: new Date().toISOString()
      };
      const key = `${s.cfg.OPENBAO_KEY_PREFIX}import-manifests`;
      manifest.signature = { key, value: await s.kms.hmac(key, canonicalJson(manifest)) };
      if (o.refreshOf) await this.db('import_jobs').where({ tenant_id: r.tenant_id, kind: 'dataset', target: 'knowledge' }).whereNot({ id: r.id }).andWhere('stored_bytes', '>', 0).andWhere('options', 'like', `%"sourceId":"${o.refreshOf}"%`).update({ stored_bytes: 0 });
      await this.im.update(r.id, { state: 'complete', stage: null, progress: 100, manifest, result: out.result, stored_bytes: out.bytes, revision: d.revision?.slice(0, 100) ?? r.revision, note: out.note.slice(0, 500), finished_at: Date.now() });
      await this.im.appendLog(r.id, { at: Date.now(), title: 'Ready', meta: out.note, tone: 'ok' });
      await this.im.audit(null, r.tenant_id, 'import.completed', { import: r.id, ref: r.ref }, { kind: 'dataset', target: r.target, destination: out.result, rows: out.kept, hash: out.hash, revision: d.revision, licence: r.licence, masked: out.scrub?.masked ?? null, signature: (manifest.signature as { value: string }).value }, r.label);
      if (r.requested_by && !o.refreshOf) await this.im.notifyUsers(r.tenant_id, [r.requested_by], `Import ${r.ref} finished`, out.note, r.label);
      await ctx.progress(100, out.note);
      return { rows: out.kept, hash: out.hash, ...out.result };
    } catch (err) {
      return fail(err);
    }
  }

  private async supersededBytes(tenantId: string, sourceId: string): Promise<number> {
    const [x] = (await this.db('import_jobs').where({ tenant_id: tenantId, kind: 'dataset', target: 'knowledge' }).andWhere('options', 'like', `%"sourceId":"${sourceId}"%`).sum({ b: 'stored_bytes' })) as { b: unknown }[];
    return Number(x?.b ?? 0);
  }

  private async toTraining(r: ImportRow, o: DatasetOptions, repo: RepositoryRow, rows: SourceRecord[]): Promise<Delivered> {
    const t = o.training!;
    const mapped: Row[] = [];
    for (const rec of rows) {
      if (!t.promptColumn) {
        mapped.push(rec.values);
        continue;
      }
      const prompt = cellText(rec.values[t.promptColumn]).trim();
      const completion = t.completionColumn ? cellText(rec.values[t.completionColumn]).trim() : null;
      // A row without its text (or without its completion) teaches nothing and is left out.
      if (!prompt || (t.completionColumn && !completion)) continue;
      mapped.push(t.completionColumn ? { prompt, completion } : { text: prompt });
    }
    if (!mapped.length) throw new ImportRefused(`No row has a value in ${t.promptColumn}${t.completionColumn ? ` and ${t.completionColumn}` : ''}.`, 'selection');
    let made;
    try {
      made = await this.s().training.registerImported({ tenantId: r.tenant_id, createdBy: r.requested_by, importId: r.id, name: t.name, label: r.label, source: `Import ${r.ref}: ${r.item_name} from ${repo.name}${o.sample ? ` (sample of ${o.sample.toLocaleString('en-US')} rows)` : ''}`, rows: mapped, splits: t.splits });
    } catch (err) {
      // Rows that are not in a training shape are a refusal of the selection, not a fault of the job.
      throw /^Line \d+ /.test((err as Error).message) ? new ImportRefused(`${(err as Error).message} Pick the prompt or text column.`, 'selection') : err;
    }
    const d = made.dataset;
    return { kept: d.rows, bytes: made.bytes, hash: d.hash!, scrub: d.scrub, note: `Training dataset ${d.name} v${d.version}: ${d.rows.toLocaleString('en-US')} rows, ${d.hash!.slice(0, 19)}`, result: { training: { datasetId: d.id, name: d.name, version: d.version, rows: d.rows, hash: d.hash, splits: d.splits } } };
  }

  private async toClassifier(r: ImportRow, o: DatasetOptions, rows: SourceRecord[]): Promise<Delivered> {
    const s = this.s();
    const c = o.classifier!;
    const pairs = rows.map((rec) => ({ text: cellText(rec.values[c.textColumn]).trim(), expected: cellText(rec.values[c.labelColumn]).trim().slice(0, 100) })).filter((x) => x.text && x.expected);
    if (!pairs.length) throw new ImportRefused(`No row has a value in both ${c.textColumn} and ${c.labelColumn}.`, 'selection');
    const { rows: clean, report } = scrubRows(pairs.map((x) => ({ text: x.text })));
    const seen = new Map<string, number>();
    for (const x of pairs) seen.set(x.expected, (seen.get(x.expected) ?? 0) + 1);
    let classifier = c.classifierId ? await s.guard.classifiers.get(r.tenant_id, c.classifierId) : undefined;
    let created = false;
    if (c.classifierId && (!classifier || classifier.tenant_id === null)) throw new Error('The classifier was removed.');
    if (!classifier) {
      if (seen.size > MAX_LABELS) throw new ImportRefused(`${c.labelColumn} has ${seen.size} different values; a classifier takes at most ${MAX_LABELS} labels. Pick another label column, or an existing classifier whose labels are among them.`, 'labels');
      const user = (await this.db('users').where({ id: r.requested_by }).first('display_name', 'username')) as { display_name: string | null; username: string } | undefined;
      classifier = await s.guard.classifiers.create(r.tenant_id, { name: c.name!, engine: c.engine, labels: [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([l]) => l), ...(c.profile ? { profile: c.profile } : {}), description: `Eval set imported from ${r.item_name} (${r.ref}).`.slice(0, 1000) }, { userId: r.requested_by, name: user?.display_name || user?.username || 'Import' });
      created = true;
    }
    const evalSet = classifier.dataset ?? `${classifier.slug}-eval`;
    const labels = new Set(classifier.config.labels.map((l) => l.label));
    const cases = pairs.map((x, i) => ({ text: String(clean[i]!.text), expected: x.expected, label: r.label })).filter((x) => labels.has(x.expected));
    if (!cases.length) throw new ImportRefused(`No row carries one of ${classifier.name}'s labels (${[...labels].slice(0, 8).join(', ')}); ${c.labelColumn} has ${[...seen.keys()].slice(0, 8).join(', ')}.`, 'labels');
    const replaced = c.mode === 'replace' && !created ? await s.guard.classifiers.clearTextCases(r.tenant_id, evalSet) : 0;
    await s.guard.classifiers.addCases(r.tenant_id, evalSet, cases, r.requested_by);
    const counts = await s.guard.classifiers.sampleCounts(r.tenant_id, classifier);
    const short = classifier.config.labels.map((l) => ({ label: l.label, samples: counts[l.label] ?? 0 })).filter((x) => x.samples < c.minPerLabel);
    let jobId: string | null = null;
    if (c.evaluate) {
      // A linear head is trained on four fifths of the set and measured on the rest; the other engines are measured.
      const job = await s.jobs.enqueue({ tenantId: r.tenant_id, type: classifier.engine === 'linear' ? 'classifier.train' : 'classifier.evaluate', payload: { classifierId: classifier.id }, createdBy: r.requested_by, maxAttempts: 1 });
      jobId = job.id;
    }
    const data = Buffer.from(toJsonl(cases.map((x) => ({ text: x.text, expected: x.expected }))), 'utf8');
    if (short.length) await this.im.appendLog(r.id, { at: Date.now(), title: 'Labels below the minimum', meta: `${short.map((x) => `${x.label} has ${x.samples}`).join(', ')}; precision and recall are unreliable below ${c.minPerLabel} samples per label`, tone: 'warn' });
    return {
      kept: cases.length,
      bytes: data.length,
      hash: sha(data),
      scrub: summary(report),
      note: `Classifier eval set ${evalSet} of ${classifier.name}: ${cases.length.toLocaleString('en-US')} cases, ${labels.size} labels${short.length ? `, ${short.length} below ${c.minPerLabel} samples` : ''}`,
      result: { classifier: { id: classifier.id, slug: classifier.slug, name: classifier.name, engine: classifier.engine, created, evalSet, cases: cases.length, replaced, skipped: pairs.length - cases.length, counts, minimum: c.minPerLabel, short, publishMinimum: MIN_SAMPLES, jobId } }
    };
  }

  private async toKnowledge(r: ImportRow, o: DatasetOptions, repo: RepositoryRow, d: DatasetDetail, source: SourceRow, rows: SourceRecord[], ctx: JobContext): Promise<Delivered> {
    const s = this.s();
    const cfg = source.config.dataset!;
    const { rows: clean, report } = scrubRows(rows.map((x) => x.values));
    const records = rows.map((x, i) => ({ ...x, values: clean[i]! }));
    const items = datasetItems(cfg, records, repo.name);
    const max = s.cfg.IMPORT_KNOWLEDGE_MAX_DOCS;
    if (items.length > max) throw new ImportRefused(`The rows make ${items.length.toLocaleString('en-US')} documents; a knowledge set holds at most ${max.toLocaleString('en-US')} (IMPORT_KNOWLEDGE_MAX_DOCS). Request it with a row limit${cfg.groupBy ? '' : ', or group the rows by a column'}.`, 'quota');
    await this.im.update(r.id, { stage: 'Indexing' });
    await this.im.appendLog(r.id, { at: Date.now(), title: 'Indexing', meta: `${items.length.toLocaleString('en-US')} documents (${cfg.groupBy ? `one per ${cfg.groupBy}` : 'one per row'}) into ${o.knowledge!.name}`, tone: '' });
    const applied = await s.knowledge.applyDataset(source, items, { signal: ctx.signal, progress: (pct, msg) => ctx.progress(64 + (pct / 100) * 34, msg) });
    if (applied.indexVersion) await this.im.appendLog(r.id, { at: Date.now(), title: 'Index swapped', meta: `index v${applied.indexVersion} built beside v${applied.retiredVersion} and now serving; v${applied.retiredVersion} retired`, tone: 'ok' });
    const now = Date.now();
    const data = Buffer.from(toJsonl(clean), 'utf8');
    const hash = sha(data);
    // "Follow the publisher": the frequency it states, or the one an SDMX table's rows carry.
    const cadence = cadenceOf(cfg.refresh, d.updates ?? frequencyIn(rows));
    const next = nextRefresh(cadence, now);
    await s.knowledge.settleDataset(source, { dataset: { ...cfg, cadence, nextRefreshAt: next, licenceStatus: r.licence_status, lastImport: r.ref, lastRows: rows.length, lastHash: hash }, watermark: d.revision ?? new Date(now).toISOString() });
    const bytes = items.reduce((a, x) => a + x.size, 0);
    return {
      kept: rows.length,
      bytes,
      hash,
      scrub: summary(report),
      note: `Knowledge set ${o.knowledge!.name}: ${items.length.toLocaleString('en-US')} documents (${applied.added} new, ${applied.changed} changed, ${applied.unchanged} unchanged, ${applied.removed} removed)${cadence ? `; next refresh ${new Date(next!).toISOString().slice(0, 16).replace('T', ' ')} UTC` : ''}`,
      result: { knowledge: { kbId: source.kb_id, sourceId: source.id, name: o.knowledge!.name, createdBase: o.knowledge!.createdBase, documents: items.length, ...applied, refresh: cfg.refresh, cadence, nextRefreshAt: next, refreshOf: o.refreshOf ?? null } }
    };
  }

  private async toStore(r: ImportRow, o: DatasetOptions, rows: SourceRecord[]): Promise<Delivered> {
    const s = this.s();
    const data = Buffer.from(toJsonl(rows.map((x) => x.values)), 'utf8');
    const key = `imports/datasets/${r.tenant_id}/${r.id}/rows.jsonl`;
    await s.blobs.put(key, Buffer.from(await s.keys.sealBytes(r.tenant_id, data, `import-dataset:${r.id}`)));
    const days = o.store!.retentionDays;
    const retainUntil = days ? Date.now() + days * 24 * 3_600_000 : null;
    return { kept: rows.length, bytes: data.length, hash: sha(data), scrub: null, note: `Dataset store ${o.store!.name}: ${rows.length.toLocaleString('en-US')} rows sealed, ${sha(data).slice(0, 19)}${retainUntil ? `; kept until ${new Date(retainUntil).toISOString().slice(0, 10)}` : ''}`, result: { store: { name: o.store!.name, key, rows: rows.length, retainUntil } } };
  }

  /** The sealed rows of a stored dataset (JSON Lines), for whoever may see the import. */
  async storedRows(p: Principal, id: string): Promise<{ name: string; data: Buffer }> {
    const r = await this.im.get(p, id);
    const st = (r.result as { store?: { name: string; key: string } } | null)?.store;
    if (r.kind !== 'dataset' || r.target !== 'store' || !st) throw notFound('Stored dataset');
    const sealed = r.stored_bytes > 0 ? await this.s().blobs.get(st.key) : null;
    if (!sealed) throw new HttpProblem(410, 'Gone', `The rows of ${r.ref} were deleted at the end of their retention; the manifest stays.`);
    return { name: st.name, data: await this.s().keys.openBytes(r.tenant_id, sealed.toString(), `import-dataset:${r.id}`) };
  }
}

/** A gated dataset the recorded token cannot read: nothing of it is fetched. */
const closed = (d: DatasetDetail): boolean => d.gated && d.access !== 'granted';

interface Delivered {
  kept: number;
  bytes: number;
  hash: string;
  scrub: Omit<ScrubReport, 'findings'> | null;
  note: string;
  result: Record<string, unknown>;
}

/** Column suggestions for the destination forms, from the preview. */
function suggest(columns: ColumnProfile[]) {
  const names = columns.map((c) => c.name);
  const strings = columns.filter((c) => c.type === 'string');
  const pick = (re: RegExp, from = names) => from.find((c) => re.test(c)) ?? null;
  const text = strings.filter((c) => /sentence|text|narrative|instruction|question|prompt|content|body|description|comment|title|name/i.test(c.name)).map((c) => c.name);
  const classes = columns.filter((c) => c.type.startsWith('class')).map((c) => c.name);
  return {
    text: text.length ? text : strings.slice(0, 3).map((c) => c.name),
    label: pick(/^(label|class|category|intent|sentiment|target)$/i) ?? pick(/label|class|category|intent|sentiment|status|product|issue/i, classes) ?? classes[0] ?? null,
    title: pick(/name|title|subject|product|entity|town/i),
    completion: pick(/^(response|completion|output|answer|label|class)$/i),
    id: pick(/^(_?id|uuid|key|code|cert)$/i)
  };
}
