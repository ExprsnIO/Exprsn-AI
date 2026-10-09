import { createHash } from 'node:crypto';
import { ulid } from 'ulid';
import { actorFrom } from '../audit/chain.js';
import { clears, highest, type Label } from '../authz/labels.js';
import { effectivePermissions, type Principal } from '../authz/policy.js';
import { canonicalJson } from '../crypto/index.js';
import { detectPii } from '../guardrails/detectors.js';
import { MIN_SAMPLES } from '../guardrails/classifiers.js';
import { conflict, HttpProblem } from '../http/problem.js';
import { loadPrincipal } from '../http/middleware.js';
import type { SourceRow, Schedule } from '../knowledge/service.js';
import type { SourceItem } from '../knowledge/sources.js';
import type { JobContext } from '../platform/jobs.js';
import type { Services } from '../services.js';
import { ADAPTERS, type AdapterContext, type DatasetDetail } from './adapters/index.js';
import { normaliseLicence } from './formats.js';
import type { RepositoryRow } from './repositories.js';
import { cellText, inferType, readRows, READABLE_FORMATS, type DatasetResource, type Row } from './rows.js';
import { ImportRefused, RateLimited, type Check, type ImportRow, type ImportState, type LicenceStatus, type LogEntry } from './types.js';
import type { ImportService } from './service.js';

/*
 * B-3804 to B-3806: dataset import. A dataset from a confirmed repository (CKAN, DCAT-AP, SDMX, OpenML, InvenioRDM,
 * Kaggle, a Hugging Face compatible hub) is read page by page from its files or its paged API and lands where the
 * Training, Classifiers and Knowledge screens already govern it:
 *
 * - the select step shows the configurations, splits and resources, and a schema preview from the first rows with
 *   the columns the PII detectors flag;
 * - the review step runs the same checks as a model import (licence against the allow-list with the legal-review
 *   exception, label against clearance, the tenant's import quota: a dataset above it is imported as a sample or
 *   not at all, the resource formats the readers accept);
 * - the `imports.dataset` job streams the rows into a staging object (never whole in memory), then registers the
 *   destination: a `training_datasets` version (`source_kind: import`, the PII scrub and the sealed rows, hash,
 *   splits and report exactly as an inline version gets them), cases of a classifier eval set (with the
 *   minimum-sample warnings, and optionally a classifier evaluated on them), a knowledge set (a knowledge base with
 *   one source of kind `dataset`, whose refresh re-reads the source and swaps rows in place), or the sealed rows
 *   alone. The manifest (source, revision, resources, rows, hash, licence, label, attribution, requester,
 *   destination) is signed and kept on the import.
 */

export type DatasetTarget = 'training' | 'classifiers' | 'knowledge' | 'store';
export const DATASET_TARGETS: readonly DatasetTarget[] = ['training', 'classifiers', 'knowledge', 'store'];

export interface DatasetPlanInput {
  repositoryId: string;
  item: string;
  configuration?: string | null;
  resources?: string[];
  splits?: string[];
  columns?: string[];
  target: DatasetTarget;
  label: Label;
  licence?: string | null;
  attribution?: string | null;
  notes?: string | null;
  exception?: { reason?: string | null } | null;
  workspaceId?: string | null;
  /** Keep at most this many rows (a dataset above the quota must be sampled). */
  sample?: number | null;
  training?: { name: string; textColumn?: string | null; labelColumn?: string | null; splits?: { train: number; val: number; test: number }; conversationData?: boolean };
  classifiers?: { evalSet: string; textColumn: string; labelColumn: string; classifier?: { mode: 'none' | 'new' | 'existing'; name?: string | null; ref?: string | null; engine?: 'linear' | 'llm' | 'guard'; profile?: string | null } | null; evaluate?: boolean };
  knowledge?: { kbId?: string | null; name?: string | null; embedModel?: string | null; titleColumn?: string | null; textColumns?: string[]; metadataColumns?: string[]; groupBy?: string | null; schedule?: Schedule | 'publisher'; dropPii?: boolean; labelFloor?: Label };
}

export interface SchemaColumn {
  name: string;
  type: 'number' | 'boolean' | 'date' | 'text';
  /** The PII kinds the detectors flagged in the preview rows (email, phone, iban, payment_card, national_id). */
  pii: string[];
  sample: string | null;
  filled: number;
}

export interface DatasetPlan {
  repository: { id: string; name: string; type: string };
  item: string;
  name: string;
  revision: string | null;
  detail: Omit<DatasetDetail, 'data'>;
  selected: DatasetResource[];
  schema: { columns: SchemaColumn[]; previewRows: number; from: string | null; piiColumns: string[] };
  sizeBytes: number | null;
  rowsEstimate: number | null;
  quota: { maxBytes: number; usedBytes: number; remainingBytes: number; overQuota: boolean; sample: number | null; maxRows: number };
  licence: { id: string; source: string; allowed: boolean; recorded: boolean; needsException: boolean };
  label: Label;
  target: DatasetTarget;
  frequency: string | null;
  schedule: Schedule;
  checks: Check[];
  blocked: boolean;
  waiting: boolean;
}

export interface DatasetResult {
  rows: number;
  sampled: boolean;
  hash: string;
  bytes: number;
  resources: { id: string; name: string; rows: number }[];
  columns: string[];
  piiColumns: string[];
  warnings: string[];
  dataset?: { id: string; name: string; version: number };
  evalSet?: { name: string; cases: number; counts: Record<string, number>; short: string[]; classifier?: { id: string; slug: string; evaluateJob?: string | null } | null };
  knowledge?: { kbId: string; kbName: string; sourceId: string; schedule: Schedule; documents?: number };
  stored?: { key: string };
}

export const PREVIEW_ROWS = 200;
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const schedules: Record<string, Schedule> = { daily: 'daily', weekly: 'weekly', monthly: 'monthly', quarterly: 'monthly', yearly: 'monthly', annual: 'monthly', hourly: 'hourly' };
/** What a refresh schedule that follows the publisher becomes. */
export const scheduleFor = (frequency: string | null): Schedule => (frequency ? (schedules[frequency.toLowerCase()] ?? 'manual') : 'manual');

const stageKey = (tenantId: string, importId: string) => `imports/${importId}.jsonl`;
const stageBlobKey = (tenantId: string, importId: string) => `training/staging/${tenantId}/${stageKey(tenantId, importId)}`;

export class DatasetImports {
  constructor(
    private readonly s: () => Services,
    private readonly imports: ImportService
  ) {}

  private get db() {
    return this.s().db;
  }

  private async audit(p: Principal | null, tenantId: string, action: string, target: Record<string, unknown>, detail: Record<string, unknown>, label?: Label, traceId?: string | null) {
    await this.s().audit.append({ tenantId, action, kind: p ? 'admin' : 'system', actor: p ? actorFrom(p) : { service: 'imports' }, target, detail, ...(label ? { label } : {}), traceId: traceId ?? null });
  }

  /** The repository, when it is active and offers datasets. */
  private async datasetRepo(p: Principal, repositoryId: string): Promise<RepositoryRow> {
    const r = await this.imports.repositories.active(p.tenantId, repositoryId);
    if (!r.kinds.includes('dataset')) throw conflict(`${r.name} does not offer datasets.`);
    return r;
  }

  private async detailOf(r: RepositoryRow, itemId: string, signal?: AbortSignal): Promise<DatasetDetail> {
    const adapter = ADAPTERS[r.type];
    if (!adapter.datasetDetail) throw conflict(`${r.name} (${r.type}) does not import datasets.`);
    const cached = await this.imports.catalog.item(r, 'dataset', itemId).catch(() => null);
    const ctx: AdapterContext = this.imports.repositories.context(r, signal);
    if (this.imports.repositories.backingOff(r)) {
      // While the source backs off, only the snapshot is read: DCAT (and the cached fields) serve from it.
      if (r.type !== 'dcat') throw new HttpProblem(503, 'Source backing off', `${r.name} is rate limiting; try again at ${new Date(r.backoff_until!).toISOString()}.`);
    }
    try {
      const d = await adapter.datasetDetail(ctx, itemId, cached ? { ...cached.data, name: cached.name, landingPage: cached.data.landingPage ?? null } : null);
      await this.imports.repositories.markOk(r, 'dataset details read');
      return d;
    } catch (err) {
      if (err instanceof RateLimited) await this.imports.repositories.markRateLimited(r, err);
      throw err;
    }
  }

  /** The select step: configurations, splits, resources and the licence as the source states them now. */
  async inspect(p: Principal, repositoryId: string, itemId: string): Promise<DatasetDetail & { source: 'live' }> {
    const r = await this.datasetRepo(p, repositoryId);
    return { ...(await this.detailOf(r, itemId)), source: 'live' };
  }

  /** Which resources an input selects: by id, by split, by configuration, else every readable one (or the first). */
  private select(d: DatasetDetail, input: Pick<DatasetPlanInput, 'configuration' | 'resources' | 'splits'>): DatasetResource[] {
    let rs = d.resources;
    if (input.configuration) rs = rs.filter((x) => !x.config || x.config === input.configuration);
    if (input.resources?.length) rs = rs.filter((x) => input.resources!.includes(x.id));
    else if (input.splits?.length) rs = rs.filter((x) => x.split && input.splits!.includes(x.split));
    else {
      const readable = rs.filter((x) => READABLE_FORMATS.has(x.format) || x.api !== 'file');
      rs = readable.length ? readable : rs.slice(0, 1);
    }
    return rs;
  }

  /** The first rows of the selected resources: the columns, their types and what the PII detectors flag. */
  async preview(r: RepositoryRow, resources: DatasetResource[], columns?: string[], signal?: AbortSignal): Promise<DatasetPlan['schema']> {
    const ctx = this.imports.repositories.context(r, signal);
    const first = resources.find((x) => x.api !== 'file' || READABLE_FORMATS.has(x.format));
    if (!first) return { columns: [], previewRows: 0, from: null, piiColumns: [] };
    const rows: Row[] = [];
    try {
      for await (const page of readRows(ctx.fetcher, ctx.access, first, { maxRows: PREVIEW_ROWS, pageSize: PREVIEW_ROWS, signal, ...(columns?.length ? { columns } : {}) })) {
        rows.push(...page);
        if (rows.length >= PREVIEW_ROWS) break;
      }
    } catch (err) {
      if (err instanceof RateLimited) throw err;
      throw new HttpProblem(422, 'Preview failed', `${first.name} could not be read: ${(err as Error).message}`);
    }
    const names = [...new Set(rows.flatMap((row) => Object.keys(row)))].slice(0, 200);
    const cols: SchemaColumn[] = names.map((name) => {
      const values = rows.map((row) => row[name]);
      const text = values.map(cellText).filter(Boolean);
      const kinds = [...new Set(detectPii(text.slice(0, PREVIEW_ROWS).join('\n')).map((d) => d.kind))];
      return { name, type: inferType(values), pii: kinds, sample: text[0]?.slice(0, 80) ?? null, filled: text.length };
    });
    return { columns: cols, previewRows: rows.length, from: first.name, piiColumns: cols.filter((c) => c.pii.length).map((c) => c.name) };
  }

  /** The review step: nothing is written. */
  async plan(p: Principal, input: DatasetPlanInput, signal?: AbortSignal): Promise<DatasetPlan> {
    const s = this.s();
    const r = await this.datasetRepo(p, input.repositoryId);
    const d = await this.detailOf(r, input.item, signal);
    const checks: Check[] = [];
    const selected = this.select(d, input);
    if (!selected.length) checks.push({ name: 'Selection', result: 'refused', detail: 'Nothing is selected: pick a configuration, a split or a resource.' });
    const unreadable = selected.filter((x) => x.api === 'file' && !READABLE_FORMATS.has(x.format));
    if (unreadable.length) checks.push({ name: 'Format', result: 'refused', detail: `${unreadable.map((x) => `${x.name} (${x.format})`).join(', ')}: only CSV, TSV, JSON, JSON Lines and the paged APIs are read. Nothing is written.` });
    else if (selected.length) checks.push({ name: 'Format', result: 'passed', detail: selected.map((x) => `${x.name}: ${x.api === 'file' ? x.format.toUpperCase() : `${x.api} API, paged`}`).join('; ') });
    // ---- size, quota and the sample
    const sizeBytes = selected.reduce((a, x) => a + (x.bytes ?? 0), 0) || d.resources.reduce((a, x) => a + (x.bytes ?? 0), 0) || null;
    const rowsEstimate = selected.reduce((a, x) => a + (x.rows ?? 0), 0) || null;
    const q = await this.imports.quota(p.tenantId);
    const remaining = Math.max(0, q.maxBytes - q.usedBytes.datasets);
    const maxRows = s.cfg.IMPORT_DATASET_MAX_ROWS;
    const sample = input.sample != null && input.sample > 0 ? Math.min(input.sample, maxRows) : null;
    const overQuota = sizeBytes != null && sizeBytes > remaining;
    if (overQuota && !sample) checks.push({ name: 'Quota', result: 'refused', detail: `${sizeBytes!.toLocaleString('en-US')} bytes selected, ${remaining.toLocaleString('en-US')} left of the tenant's ${q.maxBytes.toLocaleString('en-US')}: import a sample (\`sample\` rows) or a smaller configuration.` });
    else if (overQuota) checks.push({ name: 'Quota', result: 'warning', detail: `Above the quota: a sample of ${sample!.toLocaleString('en-US')} rows is read and the rest is not fetched.` });
    else checks.push({ name: 'Quota', result: 'passed', detail: `${sizeBytes != null ? `${sizeBytes.toLocaleString('en-US')} bytes` : 'size unknown'}; ${remaining.toLocaleString('en-US')} bytes left of the quota${sample ? `; sampled to ${sample.toLocaleString('en-US')} rows` : ''}; at most ${maxRows.toLocaleString('en-US')} rows per import.` });
    // ---- licence
    const fetched = normaliseLicence(d.licence);
    const stated = fetched !== 'unknown' && fetched !== 'other';
    const recorded = input.licence && !stated ? normaliseLicence(input.licence) : null;
    const licenceId = recorded ?? fetched;
    const allowed = await this.imports.allowedLicences(p.tenantId);
    const licenceSource = recorded ? 'recorded by the requester' : d.licenceSource;
    if (input.licence && stated && normaliseLicence(input.licence) !== fetched) checks.push({ name: 'Licence recorded', result: 'info', detail: `The source states ${fetched}; the recorded ${normaliseLicence(input.licence)} is not used. Outside the allow-list, request an exception.` });
    const unknown = licenceId === 'unknown' || licenceId === 'other';
    const needsException = !unknown && !allowed.has(licenceId);
    if (unknown) checks.push({ name: 'Licence', result: 'waiting', detail: `The source states no recognised licence${d.licence ? ` ("${d.licence.slice(0, 60)}")` : ''}. Record one to continue.` });
    else if (needsException) checks.push({ name: 'Licence', result: 'waiting', detail: `${licenceId} is outside the tenant's allow-list; the import waits for a legal-review exception.` });
    else checks.push({ name: 'Licence', result: 'passed', detail: `${licenceId}, read from ${licenceSource}.` });
    // ---- label and clearance
    if (!clears(p.clearance, input.label)) checks.push({ name: 'Label', result: 'refused', detail: `Your clearance is ${p.clearance}; the data would be labelled ${input.label}.` });
    else checks.push({ name: 'Label', result: 'passed', detail: `${input.label}; the rows and what they become carry it.` });
    // ---- destination
    const perms = effectivePermissions(p);
    const need: Record<DatasetTarget, string> = { training: 'training:submit', classifiers: 'classifiers:manage', knowledge: 'knowledge:manage', store: 'imports:run' };
    if (!perms.has(need[input.target] as never)) checks.push({ name: 'Destination', result: 'refused', detail: `Importing into ${input.target} needs ${need[input.target]} as well as imports:run.` });
    if (input.target === 'training' && !input.training?.name) checks.push({ name: 'Destination', result: 'refused', detail: 'A training dataset needs a name.' });
    if (input.target === 'classifiers' && !(input.classifiers?.evalSet && input.classifiers.textColumn && input.classifiers.labelColumn)) checks.push({ name: 'Destination', result: 'refused', detail: 'An eval set needs a name, a text column and a label column.' });
    if (input.target === 'knowledge' && !(input.knowledge?.kbId || (input.knowledge?.name && input.knowledge.embedModel))) checks.push({ name: 'Destination', result: 'refused', detail: 'A knowledge set needs an existing knowledge base, or a name and an embedding model for a new one.' });
    // ---- the schema preview (the detectors over the first rows)
    let schema: DatasetPlan['schema'] = { columns: [], previewRows: 0, from: null, piiColumns: [] };
    if (!checks.some((c) => c.result === 'refused' && (c.name === 'Format' || c.name === 'Selection'))) {
      try {
        schema = await this.preview(r, selected, input.columns, signal);
        if (schema.piiColumns.length) checks.push({ name: 'PII', result: 'warning', detail: `${schema.piiColumns.join(', ')}: flagged in ${schema.previewRows} preview rows. ${input.target === 'training' ? 'The scrub masks them before the rows are stored; the report is attached.' : input.target === 'knowledge' && input.knowledge?.dropPii ? 'These columns are dropped from the documents.' : 'Mask or drop them, or raise the label.'}` });
        else checks.push({ name: 'PII', result: 'passed', detail: `Nothing flagged in ${schema.previewRows} preview rows${schema.from ? ` of ${schema.from}` : ''}.` });
        const named = [input.training?.textColumn, input.training?.labelColumn, input.classifiers?.textColumn, input.classifiers?.labelColumn, input.knowledge?.titleColumn, input.knowledge?.groupBy, ...(input.knowledge?.textColumns ?? []), ...(input.knowledge?.metadataColumns ?? [])].filter((x): x is string => !!x);
        const missing = named.filter((c) => !schema.columns.some((x) => x.name === c));
        if (missing.length && schema.columns.length) checks.push({ name: 'Columns', result: 'refused', detail: `${missing.join(', ')}: not in the preview's columns (${schema.columns.map((c) => c.name).slice(0, 12).join(', ')}).` });
      } catch (err) {
        if (err instanceof RateLimited) checks.push({ name: 'PII', result: 'warning', detail: `${r.name} is rate limiting; the preview waits. The scrub still runs at import time.` });
        else checks.push({ name: 'Format', result: 'refused', detail: (err as HttpProblem).detail ?? (err as Error).message });
      }
    }
    const frequency = d.frequency;
    const schedule: Schedule = input.knowledge?.schedule && input.knowledge.schedule !== 'publisher' ? input.knowledge.schedule : scheduleFor(frequency);
    const blocked = checks.some((c) => c.result === 'refused');
    const { data: _d, ...detail } = d;
    return {
      repository: { id: r.id, name: r.name, type: r.type },
      item: d.itemId,
      name: d.name,
      revision: d.revision,
      detail,
      selected,
      schema,
      sizeBytes,
      rowsEstimate,
      quota: { maxBytes: q.maxBytes, usedBytes: q.usedBytes.datasets, remainingBytes: remaining, overQuota, sample, maxRows },
      licence: { id: licenceId, source: licenceSource, allowed: !unknown && allowed.has(licenceId), recorded: !!recorded, needsException },
      label: input.label,
      target: input.target,
      frequency,
      schedule,
      checks,
      blocked,
      waiting: !blocked && checks.some((c) => c.result === 'waiting')
    };
  }

  /** The confirm step: a refused plan is recorded as refused, a licence outside the policy waits, the rest is queued. */
  async request(p: Principal, input: DatasetPlanInput, traceId?: string | null) {
    const s = this.s();
    const plan = await this.plan(p, input);
    const r = await this.datasetRepo(p, input.repositoryId);
    const t = Date.now();
    const options = { ...input, selectedResources: plan.selected.map((x) => x.id), schedule: plan.schedule, frequency: plan.frequency, columns: input.columns ?? [], piiColumns: plan.schema.piiColumns };
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
      files: '[]',
      options: JSON.stringify(options),
      checks: JSON.stringify(plan.checks),
      licence: plan.licence.id,
      label: input.label,
      attribution: input.attribution ?? null,
      size_bytes: plan.sizeBytes ?? 0,
      stored_bytes: 0,
      rows_total: plan.rowsEstimate ?? 0,
      sample_rows: plan.quota.sample,
      requested_by: p.userId,
      created_at: t,
      updated_at: t
    };
    if (plan.blocked) {
      const refused = plan.checks.filter((c) => c.result === 'refused');
      const ref = await this.imports.insertRef(p.tenantId, 'import_jobs', `IMP-${new Date(t).getUTCFullYear()}-`, { ...base, state: 'refused', stage: null, note: refused[0]!.detail.slice(0, 500), log: JSON.stringify([{ at: t, title: 'Refused', meta: refused.map((c) => `${c.name}: ${c.detail}`).join(' ').slice(0, 1000), tone: 'danger' }]), licence_status: 'allowed', finished_at: t });
      await this.audit(p, p.tenantId, 'import.refused', { import: base.id, ref, repository: r.id, item: plan.item }, { checks: refused, kind: 'dataset', target: input.target }, input.label, traceId);
      throw new HttpProblem(422, 'Import refused', refused.map((c) => c.detail).join(' '), { extensions: { import: await this.imports.view(p.tenantId, (await this.imports.row(p.tenantId, base.id))!), checks: plan.checks, reason: refused.map((c) => c.name.toLowerCase()) } });
    }
    if (plan.licence.id === 'unknown' || plan.licence.id === 'other') throw new HttpProblem(409, 'Licence not recorded', 'The source states no recognised licence. Record it (`licence`) to continue; outside the allow-list it then waits for legal review.', { extensions: { reason: 'licence', checks: plan.checks } });
    if (plan.licence.needsException && !input.exception) throw new HttpProblem(409, 'Licence exception required', `${plan.licence.id} is outside the tenant's allow-list. Request an exception (\`exception: {reason}\`); the import then waits for the legal-review role.`, { extensions: { reason: 'licence-exception', licence: plan.licence.id, checks: plan.checks } });
    const state: ImportState = plan.licence.needsException ? 'waiting on licence' : 'queued';
    const licenceStatus: LicenceStatus = plan.licence.needsException ? 'exception pending' : 'allowed';
    const log: LogEntry[] = [{ at: t, title: 'Request accepted', meta: `${plan.licence.id} read from ${plan.licence.source}; ${plan.selected.length} resource${plan.selected.length === 1 ? '' : 's'}${plan.quota.sample ? `; sampled to ${plan.quota.sample.toLocaleString('en-US')} rows` : ''}`, tone: 'ok' }];
    const ref = await this.imports.insertRef(p.tenantId, 'import_jobs', `IMP-${new Date(t).getUTCFullYear()}-`, { ...base, state, stage: null, note: state === 'waiting on licence' ? `${plan.licence.id} is outside the tenant policy; waiting on legal review` : `Queued: ${input.target}`, log: JSON.stringify(log), licence_status: licenceStatus });
    await this.audit(p, p.tenantId, 'import.requested', { import: base.id, ref, repository: r.id, item: plan.item }, { kind: 'dataset', target: input.target, revision: plan.revision, licence: plan.licence, label: input.label, resources: plan.selected.map((x) => x.id), sample: plan.quota.sample }, input.label, traceId);
    if (state === 'waiting on licence') await this.imports.requestException(p, base.id, ref, plan.licence.id, input.exception?.reason ?? null, plan.name, input.label, traceId);
    else await this.enqueue(p.tenantId, base.id, p.userId);
    void s;
    return this.imports.view(p.tenantId, (await this.imports.row(p.tenantId, base.id))!);
  }

  async enqueue(tenantId: string, importId: string, by: string | null, runAt?: number): Promise<string> {
    const job = await this.s().jobs.enqueue({ tenantId, type: 'imports.dataset', payload: { importId }, createdBy: by, maxAttempts: 1, ...(runAt ? { runAt } : {}) });
    await this.db('import_jobs').where({ id: importId }).update({ job_id: job.id, updated_at: Date.now() });
    return job.id;
  }

  // ---------- the job ----------

  /** Streams the selected resources into one JSON Lines staging object, capped by the sample or the maximum. */
  private async stage(r: ImportRow, repo: RepositoryRow, d: DatasetDetail, ctx: JobContext): Promise<{ rows: number; bytes: number; hash: string; resources: DatasetResult['resources']; columns: string[]; capped: boolean }> {
    const s = this.s();
    const o = r.options as unknown as DatasetPlanInput & { selectedResources?: string[]; columns?: string[] };
    const selected = this.select(d, { resources: o.selectedResources ?? o.resources ?? [], configuration: o.configuration ?? null, splits: o.splits ?? [] });
    if (!selected.length) throw new ImportRefused('The selected resources are no longer published by the source.', 'selection');
    const actx = this.imports.repositories.context(repo, ctx.signal);
    const maxRows = r.sample_rows ?? s.cfg.IMPORT_DATASET_MAX_ROWS;
    const maxBytes = s.cfg.IMPORT_MAX_BYTES;
    // A training version needs each row in the shape the scrub and the trainers read: `text` (and `label`), the
    // other columns beside them; the text column is the one the wizard named, else the first text-like column.
    const tr = r.target === 'training' ? (o.training ?? { name: '' }) : null;
    const shape = (row: Row): Row => {
      if (!tr) return row;
      if (typeof row.text === 'string' && !tr.textColumn && !tr.labelColumn) return row;
      if (!tr.textColumn && ((typeof row.prompt === 'string' && typeof row.completion === 'string') || (typeof row.instruction === 'string' && typeof row.output === 'string') || Array.isArray(row.messages))) return row;
      const textCol = tr.textColumn ?? Object.keys(row).find((c) => /^(text|narrative|sentence|content|body|question|prompt)$/i.test(c)) ?? null;
      const text = textCol ? cellText(row[textCol]) : Object.entries(row).map(([k, v]) => `${k}: ${cellText(v)}`).join('\n');
      const { [textCol ?? '']: _t, ...rest } = row;
      const out: Row = { text, ...rest };
      if (tr.labelColumn) out.label = cellText(row[tr.labelColumn]);
      return out;
    };
    const hash = createHash('sha256');
    const parts: Buffer[] = [];
    let rows = 0;
    let bytes = 0;
    const columns = new Set<string>();
    const perResource: DatasetResult['resources'] = [];
    let capped = false;
    for (const res of selected) {
      if (rows >= maxRows) break;
      let n = 0;
      for await (const page of readRows(actx.fetcher, actx.access, res, { maxRows: maxRows - rows, pageSize: 1000, signal: ctx.signal, ...(o.columns?.length ? { columns: o.columns } : {}) })) {
        const lines = page.map((raw) => {
          const row = shape(raw);
          const out: Row = res.split && !('split' in row) ? { ...row, split: res.split } : row;
          for (const k of Object.keys(out)) columns.add(k);
          return JSON.stringify(out);
        });
        const chunk = Buffer.from(lines.join('\n') + '\n', 'utf8');
        bytes += chunk.length;
        if (bytes > maxBytes) throw new ImportRefused(`The rows exceed IMPORT_MAX_BYTES (${maxBytes.toLocaleString('en-US')} bytes); import a sample.`, 'size');
        hash.update(chunk);
        parts.push(chunk);
        rows += page.length;
        n += page.length;
        await ctx.progress(5 + Math.min(55, (rows / Math.max(rows, r.rows_total || maxRows)) * 55), `${res.name}: ${rows.toLocaleString('en-US')} rows`);
        if (rows >= maxRows) {
          capped = true;
          break;
        }
      }
      perResource.push({ id: res.id, name: res.name, rows: n });
    }
    if (!rows) throw new ImportRefused('The source returned no rows for the selection.', 'rows');
    await s.blobs.put(stageBlobKey(r.tenant_id, r.id), Buffer.concat(parts), 'application/x-ndjson');
    return { rows, bytes, hash: `sha256:${hash.digest('hex')}`, resources: perResource, columns: [...columns], capped };
  }

  /** Reads the staged rows back (the destinations that need them in memory: eval sets and the store). */
  private async stagedRows(r: ImportRow): Promise<Row[]> {
    const b = await this.s().blobs.get(stageBlobKey(r.tenant_id, r.id));
    if (!b) throw new Error('The staged rows are gone.');
    return b.toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Row);
  }

  async run(importId: string, ctx: JobContext): Promise<unknown> {
    const s = this.s();
    const raw = await this.db('import_jobs').where({ id: importId }).first();
    if (!raw) return { skipped: 'gone' };
    let r = this.imports.rowFrom(raw);
    if (r.state !== 'queued' && r.state !== 'running') return { skipped: r.state };
    const repo = await this.imports.repositories.get(r.tenant_id, r.repository_id).catch(() => null);
    const fail = async (err: unknown) => {
      const fresh = (await this.imports.row(r.tenant_id, r.id))!;
      if (fresh.state === 'cancelled') {
        await s.blobs.delete(stageBlobKey(r.tenant_id, r.id)).catch(() => undefined);
        return { cancelled: true };
      }
      if (err instanceof RateLimited && repo) {
        const until = await this.imports.repositories.markRateLimited(repo, err);
        await this.imports.patch(r.id, { state: 'queued', stage: 'Waiting on the source', note: `${repo.name} is rate limiting; resumes at ${new Date(until).toISOString()}` });
        await this.imports.log(r.id, { at: Date.now(), title: 'Rate limited', meta: `backing off until ${new Date(until).toISOString()}`, tone: 'warn' });
        await this.enqueue(r.tenant_id, r.id, r.requested_by, until);
        return { rateLimited: until };
      }
      const refused = err instanceof ImportRefused;
      const msg = (err as Error).message.slice(0, 1000);
      await this.imports.patch(r.id, { state: refused ? 'refused' : 'failed', stage: null, note: msg.slice(0, 500), error: msg, finished_at: Date.now() });
      await this.imports.log(r.id, { at: Date.now(), title: refused ? 'Refused' : 'Failed', meta: msg, tone: 'danger' });
      await s.blobs.delete(stageBlobKey(r.tenant_id, r.id)).catch(() => undefined);
      await this.audit(null, r.tenant_id, refused ? 'import.refused' : 'import.failed', { import: r.id, ref: r.ref }, { error: msg, kind: 'dataset', ...(refused ? { reason: (err as ImportRefused).reason } : {}) }, r.label);
      await this.imports.notify(r.tenant_id, [r.requested_by], refused ? `Import ${r.ref} refused` : `Import ${r.ref} failed`, msg, r.label);
      throw err instanceof Error ? err : new Error(String(err));
    };
    try {
      if (!repo) throw new Error('The repository was deleted.');
      if (repo.state !== 'active') throw new Error(`${repo.name} is ${repo.state}.`);
      await this.imports.patch(r.id, { state: 'running', stage: 'Reading the source', started_at: r.started_at ?? Date.now(), error: null });
      await ctx.progress(2, 'Reading the source');
      const d = await this.detailOf(repo, r.item_id, ctx.signal);
      const fetched = normaliseLicence(d.licence);
      if (fetched !== 'unknown' && fetched !== 'other' && fetched !== r.licence && r.licence_status === 'allowed' && !(await this.imports.allowedLicences(r.tenant_id)).has(fetched)) throw new ImportRefused(`The licence the source states now is ${fetched}, not ${r.licence}, and it is outside the allow-list. Nothing is written.`, 'licence');
      if (r.revision && d.revision && d.revision !== r.revision) await this.imports.log(r.id, { at: Date.now(), title: 'Source changed', meta: `the source now reports ${d.revision.slice(0, 40)} (requested at ${r.revision.slice(0, 40)}); the rows read now are the ones kept`, tone: 'warn' });
      await this.imports.patch(r.id, { stage: 'Fetching rows', revision: (d.revision ?? r.revision)?.slice(0, 100) ?? null });
      const staged = await this.stage(r, repo, d, ctx);
      await this.imports.admitDataset(r.tenant_id, staged.bytes);
      await this.imports.patch(r.id, { stored_bytes: staged.bytes, rows_total: staged.rows, stage: 'Registering', progress: 62 });
      await this.imports.log(r.id, { at: Date.now(), title: 'Rows fetched', meta: `${staged.rows.toLocaleString('en-US')} rows, ${staged.bytes.toLocaleString('en-US')} bytes, ${staged.hash.slice(0, 23)}${staged.capped ? ' (sample)' : ''}; ${staged.resources.map((x) => `${x.name} ${x.rows.toLocaleString('en-US')}`).join(', ')}`, tone: 'ok' });
      await ctx.progress(65, 'Registering');
      r = (await this.imports.row(r.tenant_id, r.id))!;
      const o = r.options as unknown as DatasetPlanInput & { piiColumns?: string[]; schedule?: Schedule; frequency?: string | null };
      const result: DatasetResult = { rows: staged.rows, sampled: staged.capped || r.sample_rows != null, hash: staged.hash, bytes: staged.bytes, resources: staged.resources, columns: staged.columns, piiColumns: o.piiColumns ?? [], warnings: [] };
      const ids: Record<string, unknown> = {};
      if (r.target === 'training') {
        const ds = await this.toTraining(r, repo, o, result);
        ids.dataset_id = ds.id;
        result.dataset = ds;
      } else if (r.target === 'classifiers') {
        const es = await this.toEvalSet(r, o, result);
        ids.eval_set = es.name;
        if (es.classifier) ids.classifier_id = es.classifier.id;
        result.evalSet = es;
      } else if (r.target === 'knowledge') {
        const ks = await this.toKnowledge(r, repo, d, o, result);
        ids.kb_id = ks.kbId;
        ids.source_id = ks.sourceId;
        result.knowledge = ks;
      } else {
        const key = `imports/datasets/${r.tenant_id}/${r.id}.jsonl`;
        const b = (await s.blobs.get(stageBlobKey(r.tenant_id, r.id)))!;
        await s.blobs.put(key, Buffer.from(await s.keys.sealBytes(r.tenant_id, b, `import-dataset:${r.id}`)));
        result.stored = { key };
      }
      // The staging object stays for a knowledge set's first sync (which reads the source again) and the training
      // scrub (which deletes it); the others are done with it.
      if (r.target !== 'training') await s.blobs.delete(stageBlobKey(r.tenant_id, r.id)).catch(() => undefined);
      await this.finish(r, repo, d, result, ids);
      await ctx.progress(100, `Registered: ${r.target}`);
      return { rows: staged.rows, target: r.target, ...ids };
    } catch (err) {
      return fail(err);
    }
  }

  private async toTraining(r: ImportRow, repo: RepositoryRow, o: DatasetPlanInput, result: DatasetResult): Promise<{ id: string; name: string; version: number }> {
    const s = this.s();
    const tr = o.training!;
    const ds = await s.training.registerImported({
      tenantId: r.tenant_id,
      by: r.requested_by,
      importId: r.id,
      name: tr.name,
      label: r.label,
      source: `Imported from ${repo.name}: ${r.item_name} (${r.ref})`.slice(0, 500),
      stagingPath: stageKey(r.tenant_id, r.id),
      conversationData: !!tr.conversationData,
      splits: tr.splits ?? { train: 80, val: 10, test: 10 },
      ...(tr.textColumn || tr.labelColumn ? { columns: { text: tr.textColumn ?? null, label: tr.labelColumn ?? null } } : {})
    });
    await this.imports.log(r.id, { at: Date.now(), title: 'Dataset version registered', meta: `Training: ${ds.name} v${ds.version}; the PII scrub runs now and attaches its report`, tone: 'ok' });
    void result;
    return { id: ds.id, name: ds.name, version: ds.version };
  }

  private async toEvalSet(r: ImportRow, o: DatasetPlanInput, result: DatasetResult): Promise<NonNullable<DatasetResult['evalSet']>> {
    const s = this.s();
    const c = o.classifiers!;
    const rows = await this.stagedRows(r);
    const items = rows.map((row) => ({ text: cellText(row[c.textColumn]), expected: cellText(row[c.labelColumn]).trim().slice(0, 100), label: r.label })).filter((x) => x.text && x.expected);
    if (!items.length) throw new ImportRefused(`No row has both ${c.textColumn} and ${c.labelColumn}.`, 'columns');
    const counts: Record<string, number> = {};
    for (const it of items) counts[it.expected] = (counts[it.expected] ?? 0) + 1;
    const labels = Object.keys(counts).sort();
    if (labels.length > 50) throw new ImportRefused(`${c.labelColumn} has ${labels.length} distinct values; an eval set's labels are at most 50. Pick the label column again.`, 'labels');
    await s.guard.classifiers.addCases(r.tenant_id, c.evalSet, items, r.requested_by);
    const short = labels.filter((l) => counts[l]! < MIN_SAMPLES);
    if (short.length) result.warnings.push(`Below ${MIN_SAMPLES} samples: ${short.map((l) => `${l} (${counts[l]})`).join(', ')}. Precision and recall for them are marked unreliable until the eval set grows, and a classifier cannot publish on them.`);
    await this.imports.log(r.id, { at: Date.now(), title: 'Eval set filled', meta: `${c.evalSet}: ${items.length.toLocaleString('en-US')} cases, ${labels.length} labels${short.length ? `; ${short.length} below ${MIN_SAMPLES} samples` : ''}`, tone: short.length ? 'warn' : 'ok' });
    let classifier: NonNullable<DatasetResult['evalSet']>['classifier'] = null;
    const want = c.classifier;
    if (want && want.mode !== 'none') {
      let row = want.mode === 'existing' ? await s.guard.classifiers.get(r.tenant_id, want.ref ?? '') : undefined;
      if (want.mode === 'existing') {
        if (!row) throw new ImportRefused(`The classifier ${want.ref} does not exist.`, 'classifier');
        if (row.tenant_id === null) throw new ImportRefused(`${row.name} is a platform classifier; its eval set is read-only here. Add the rows to a tenant classifier.`, 'classifier');
        if (row.dataset !== c.evalSet) row = await s.guard.classifiers.update(row, { dataset: c.evalSet }, r.requested_by);
      } else {
        if (labels.length > 20) throw new ImportRefused(`A new classifier takes at most 20 labels; ${c.labelColumn} has ${labels.length}.`, 'labels');
        const user = await this.db('users').where({ id: r.requested_by }).first('display_name');
        const engine = want.engine ?? 'linear';
        row = await s.guard.classifiers.create(r.tenant_id, { name: want.name ?? c.evalSet, engine, labels, dataset: c.evalSet, ...(want.profile ? { profile: want.profile } : {}), description: `From the import ${r.ref}` }, { userId: r.requested_by, name: String(user?.display_name ?? '') });
      }
      let evaluateJob: string | null = null;
      if (c.evaluate !== false) {
        const type = row.engine === 'linear' && !row.config.head ? 'classifier.train' : 'classifier.evaluate';
        const job = await s.jobs.enqueue({ tenantId: r.tenant_id, type, payload: { tenantId: r.tenant_id, classifierId: row.id }, createdBy: r.requested_by, maxAttempts: 1 });
        evaluateJob = job.id;
        await this.imports.log(r.id, { at: Date.now(), title: type === 'classifier.train' ? 'Training queued' : 'Evaluation queued', meta: `${row.name}: job ${job.id}; precision and recall per label land on the Classifiers screen`, tone: '' });
      }
      classifier = { id: row.id, slug: row.slug, evaluateJob };
    }
    return { name: c.evalSet, cases: items.length, counts, short, classifier };
  }

  private async toKnowledge(r: ImportRow, repo: RepositoryRow, d: DatasetDetail, o: DatasetPlanInput & { schedule?: Schedule; frequency?: string | null }, result: DatasetResult): Promise<NonNullable<DatasetResult['knowledge']>> {
    const s = this.s();
    const k = o.knowledge!;
    const p = await loadPrincipal(s, r.tenant_id, r.requested_by, {});
    if (!p) throw new Error('The requester no longer exists.');
    p.workspaceId = r.workspace_id;
    let kbId = k.kbId ?? null;
    let kbName: string;
    if (kbId) {
      const kb = await s.knowledge.base(p, kbId, 'manage');
      kbName = kb.name;
    } else {
      const kb = await s.knowledge.create(p, { name: k.name!, description: `Knowledge set from ${repo.name}: ${r.item_name}`.slice(0, 500), label: highest(r.label, k.labelFloor ?? r.label), embedModel: k.embedModel!, reranker: null, sharing: 'members', workspaceId: r.workspace_id });
      kbId = kb.id;
      kbName = kb.name;
      await this.audit(p, r.tenant_id, 'knowledge.created', { kb: kb.id, name: kb.name }, { embedModel: kb.embed_model, sharing: kb.sharing, workspace: kb.workspace_id, import: r.ref }, kb.label);
    }
    const schedule: Schedule = o.schedule ?? scheduleFor(d.frequency);
    const src = await s.knowledge.addSource(p, kbId, {
      kind: 'dataset',
      location: `dataset: ${repo.name} ${r.item_id}`.slice(0, 500),
      labelFloor: highest(r.label, k.labelFloor ?? r.label),
      schedule,
      dataset: { importId: r.id, repositoryId: repo.id, item: r.item_id, configuration: o.configuration ?? null, resources: (r.options as { selectedResources?: string[] }).selectedResources ?? [], titleColumn: k.titleColumn ?? null, textColumns: k.textColumns ?? [], metadataColumns: k.metadataColumns ?? [], groupBy: k.groupBy ?? null, dropPii: !!k.dropPii, piiColumns: result.piiColumns, maxRows: r.sample_rows ?? s.cfg.IMPORT_DATASET_MAX_ROWS, columns: o.columns ?? [], frequency: d.frequency }
    });
    await this.audit(p, r.tenant_id, 'knowledge.source.added', { kb: kbId, source: src.id }, { kind: 'dataset', location: src.location, schedule, import: r.ref }, src.label_floor);
    await this.imports.log(r.id, { at: Date.now(), title: 'Knowledge set created', meta: `${kbName}: one source of kind dataset, refresh ${schedule}${d.frequency ? ` (the publisher updates ${d.frequency})` : ''}; the first sync indexes the rows with citations back to each row`, tone: 'ok' });
    return { kbId, kbName, sourceId: src.id, schedule };
  }

  /** The signed manifest, the ids on the row, the notices. */
  private async finish(r: ImportRow, repo: RepositoryRow, d: DatasetDetail, result: DatasetResult, ids: Record<string, unknown>): Promise<void> {
    const s = this.s();
    const user = await this.db('users').where({ id: r.requested_by }).first('username');
    const manifest: Record<string, unknown> = {
      format: 'exprsn-import-manifest/1',
      kind: 'dataset',
      import: r.ref,
      source: { repository: repo.name, type: repo.type, baseUrl: repo.base_url, item: r.item_id, revision: d.revision ?? r.revision, landingPage: d.landingPage },
      resources: result.resources,
      rows: result.rows,
      sampled: result.sampled,
      hash: result.hash,
      bytes: result.bytes,
      columns: result.columns,
      piiColumns: result.piiColumns,
      licence: { id: r.licence, source: d.licenceSource, status: r.licence_status },
      label: r.label,
      attribution: r.attribution,
      requester: { id: r.requested_by, username: user?.username ?? null },
      destination: { target: r.target, ...ids },
      registeredAt: new Date().toISOString()
    };
    const key = `${s.cfg.OPENBAO_KEY_PREFIX}import-manifests`;
    manifest.signature = { key, value: await s.kms.hmac(key, canonicalJson(manifest)) };
    const note = r.target === 'training' ? `Training dataset ${result.dataset!.name} v${result.dataset!.version}, ${result.rows.toLocaleString('en-US')} rows` : r.target === 'classifiers' ? `Eval set ${result.evalSet!.name}, ${result.evalSet!.cases.toLocaleString('en-US')} cases${result.evalSet!.short.length ? `, ${result.evalSet!.short.length} labels below ${MIN_SAMPLES}` : ''}` : r.target === 'knowledge' ? `Knowledge set ${result.knowledge!.kbName}, ${result.rows.toLocaleString('en-US')} rows, refresh ${result.knowledge!.schedule}` : `${result.rows.toLocaleString('en-US')} rows stored, ${result.hash.slice(0, 23)}`;
    await this.imports.patch(r.id, { state: 'complete', stage: null, progress: 100, manifest, note: note.slice(0, 500), finished_at: Date.now(), ...ids, result: JSON.stringify(result) } as never);
    await this.imports.log(r.id, { at: Date.now(), title: 'Registered', meta: note, tone: 'ok' });
    await this.audit(null, r.tenant_id, 'import.completed', { import: r.id, ref: r.ref, ...ids }, { kind: 'dataset', target: r.target, rows: result.rows, hash: result.hash, sampled: result.sampled, licence: r.licence, signature: (manifest.signature as { value: string }).value.slice(0, 16), warnings: result.warnings }, r.label);
    await this.imports.notify(r.tenant_id, [r.requested_by], `Import ${r.ref} finished`, `${note}.${result.warnings.length ? ` ${result.warnings[0]}` : ''}`, r.label);
  }

  // ---------- knowledge sets (B-3805): the source's rows, read again on every refresh ----------

  /**
   * The documents of a `dataset` knowledge source: the rows read from the source now (the same cap as the import),
   * one document per row or per group, keyed by the row's position in the group or the group value, so a refresh
   * re-indexes changed rows only, removes rows that are gone and leaves the rest serving (the swap is per document).
   */
  async knowledgeItems(src: SourceRow, ctx: Pick<JobContext, 'signal' | 'progress'>): Promise<SourceItem[]> {
    const cfg = src.config.dataset;
    if (!cfg) throw new Error('The dataset source has no configuration.');
    const repo = await this.imports.repositories.get(src.tenant_id, cfg.repositoryId);
    if (repo.state !== 'active') throw new Error(`${repo.name} is ${repo.state}.`);
    const d = await this.detailOf(repo, cfg.item, ctx.signal);
    const selected = this.select(d, { resources: cfg.resources, configuration: cfg.configuration ?? null });
    if (!selected.length) throw new Error('The selected resources are no longer published by the source.');
    const actx = this.imports.repositories.context(repo, ctx.signal);
    const drop = new Set(cfg.dropPii ? cfg.piiColumns ?? [] : []);
    const textCols = cfg.textColumns?.length ? cfg.textColumns : null;
    const metaCols = cfg.metadataColumns ?? [];
    const groups = new Map<string, { title: string; rows: { n: number; row: Row; resource: string }[] }>();
    let n = 0;
    const cite = (resource: string, row: number) => `${repo.name}, ${d.name} (${cfg.item}), ${resource}, row ${row}`;
    for (const res of selected) {
      for await (const page of readRows(actx.fetcher, actx.access, res, { maxRows: cfg.maxRows - n, pageSize: 1000, signal: ctx.signal, ...(cfg.columns?.length ? { columns: cfg.columns } : {}) })) {
        for (const row of page) {
          n++;
          const title = cfg.titleColumn ? cellText(row[cfg.titleColumn]).trim() : '';
          const groupKey = cfg.groupBy ? cellText(row[cfg.groupBy]).trim() || '(blank)' : `${res.id}#${n}`;
          const g = groups.get(groupKey) ?? { title: cfg.groupBy ? `${cfg.groupBy}: ${groupKey}` : title || `${d.name} row ${n}`, rows: [] };
          g.rows.push({ n, row, resource: res.name });
          groups.set(groupKey, g);
        }
        if (n >= cfg.maxRows) break;
      }
      if (n >= cfg.maxRows) break;
    }
    const items: SourceItem[] = [];
    for (const [key, g] of groups) {
      const body = [`# ${g.title}`, ''];
      for (const { n: rowN, row, resource } of g.rows) {
        const cols = Object.keys(row).filter((c) => !drop.has(c));
        const text = (textCols ?? cols.filter((c) => !metaCols.includes(c))).map((c) => cellText(row[c])).filter(Boolean).join('\n');
        const meta = metaCols.filter((c) => c in row && !drop.has(c)).map((c) => `${c}: ${cellText(row[c])}`);
        if (g.rows.length > 1) body.push(`## Row ${rowN}`);
        if (cfg.titleColumn && g.rows.length > 1) body.push(cellText(row[cfg.titleColumn]));
        body.push(text || cols.map((c) => `${c}: ${cellText(row[c])}`).join('\n'), ...(meta.length ? ['', ...meta] : []), '', `Source: ${cite(resource, rowN)}`, '');
      }
      const data = Buffer.from(body.join('\n'), 'utf8');
      items.push({ key: `${cfg.item}#${key}`, name: `${g.title}${g.rows.length === 1 ? ` (row ${g.rows[0]!.n})` : ` (${g.rows.length} rows)`}`.slice(0, 300), version: sha(data), size: data.length, read: async () => data, type: 'text/plain' });
    }
    await ctx.progress(5, `${n.toLocaleString('en-US')} rows read from ${repo.name}`);
    return items;
  }
}
