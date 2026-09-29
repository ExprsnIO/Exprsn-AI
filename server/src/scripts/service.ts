import { ulid } from 'ulid';
import type { Logger } from 'pino';
import { json, type Db } from '../db/knex.js';
import { clears, labelRank, type Label } from '../authz/labels.js';
import type { Principal } from '../authz/policy.js';
import { conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import { TOPICS, type Bus } from '../platform/bus.js';
import type { DataKeys } from '../platform/datakeys.js';
import type { JobQueue } from '../platform/jobs.js';
import type { Guardrails } from '../guardrails/types.js';
import { scanSecrets } from '../registry/checks.js';
import type { EntryRow, RegistryService, SideEffect } from '../registry/service.js';
import type { JsonSchema } from '../registry/schema.js';
import { DEFAULT_LIMITS, RunnerUnavailable, type Language, type RunResult, type ScriptLimits, type ScriptRunner } from './runner.js';

export type ScriptStatus = 'draft' | 'tested' | 'in_review' | 'promoted';

export interface ScriptRow {
  id: string;
  tenant_id: string;
  workspace_id: string | null;
  name: string;
  language: Language;
  label: Label;
  status: ScriptStatus;
  version: number;
  registry_id: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface ScriptCheck {
  name: string;
  result: string;
  tone: 'ok' | 'warn' | 'danger';
  detail: string;
  line?: number;
}

interface VersionRow {
  id: string;
  script_id: string;
  version: number;
  source: string;
  limits: string;
  checks: string;
  note: string | null;
  created_by: string | null;
  created_at: number;
}

interface RunRow {
  id: string;
  tenant_id: string;
  script_id: string;
  version: number;
  job_id: string | null;
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'timeout' | 'cancelled';
  input: string | null;
  stdout: string | null;
  stderr: string | null;
  exit_code: number | null;
  duration_ms: number | null;
  truncated: boolean | number;
  runner: string | null;
  error: string | null;
  created_by: string | null;
  created_at: number;
  finished_at: number | null;
}

/** Imports that reach the network or spawn processes. Scripts run with no network, so these are refused up front. */
const BLOCKED: Record<Language, RegExp[]> = {
  python: [/^\s*(?:import|from)\s+(requests|urllib3?|http|httpx|aiohttp|socket|ftplib|smtplib|telnetlib|paramiko|subprocess|pty)\b/],
  javascript: [/\b(?:require\(\s*|from\s+|import\(\s*)['"](?:node:)?(http|https|http2|net|dgram|tls|child_process|cluster|worker_threads|undici|axios|node-fetch)['"]/, /(?:^|[^.\w])(fetch)\s*\(/]
};

export function blockedModules(language: Language, source: string): { module: string; line: number }[] {
  const out: { module: string; line: number }[] = [];
  source.split('\n').forEach((l, i) => {
    for (const re of BLOCKED[language]) {
      const m = re.exec(l);
      if (m) out.push({ module: m[1]!, line: i + 1 });
    }
  });
  return out;
}

const blocking = (checks: ScriptCheck[]) => checks.filter((c) => c.tone === 'danger');

/**
 * Scripts: source, language and limits, versioned (a version is never overwritten), sealed at rest. Every version
 * passes checks before it may run: the `script` guardrail checkpoint, blocked network and process modules, and a
 * secrets scan. Runs are jobs executed by the ScriptRunner (a disposable container with no network), capturing
 * stdout, stderr and the exit code. The promotion path: draft → tested (a clean run of the current version) →
 * submitted as a draft registry tool → promoted once a tool admin publishes it.
 */
export class ScriptService {
  constructor(
    private readonly db: Db,
    private readonly keys: DataKeys,
    private readonly jobs: JobQueue,
    private readonly bus: Bus,
    private readonly registry: RegistryService,
    private readonly guard: () => Guardrails,
    public runner: ScriptRunner,
    private readonly log: Logger
  ) {}

  registerJobs(): void {
    this.jobs.register('script.run', async (p, ctx) => this.execute(String(p.runId), ctx.signal, (pct, m) => ctx.progress(pct, m)), { timeoutMs: 15 * 60_000 });
  }

  // ---------- reads ----------

  async list(p: Principal): Promise<ScriptRow[]> {
    const q = this.db('scripts').where({ tenant_id: p.tenantId });
    if (p.workspaceId) q.andWhere({ workspace_id: p.workspaceId });
    else q.whereNull('workspace_id');
    const rows = (await q.orderBy('name')) as ScriptRow[];
    return rows.filter((r) => clears(p.clearance, r.label));
  }

  async get(p: Principal, id: string): Promise<ScriptRow> {
    const s = (await this.db('scripts').where({ tenant_id: p.tenantId, id }).first()) as ScriptRow | undefined;
    if (!s || (s.workspace_id ?? null) !== (p.workspaceId ?? null)) throw notFound('Script');
    if (!clears(p.clearance, s.label)) throw forbidden(`This script is ${s.label}; your clearance is ${p.clearance}.`, { step: 'clearance' });
    return s;
  }

  private async versionRow(scriptId: string, version: number): Promise<VersionRow> {
    const v = (await this.db('script_versions').where({ script_id: scriptId, version }).first()) as VersionRow | undefined;
    if (!v) throw notFound('Version');
    return v;
  }

  async version(s: ScriptRow, version = s.version) {
    const v = await this.versionRow(s.id, version);
    return { version: v.version, source: await this.keys.open(s.tenant_id, v.source, `script:${v.id}`), limits: json<ScriptLimits>(v.limits, DEFAULT_LIMITS), checks: json<ScriptCheck[]>(v.checks, []), note: v.note, createdBy: v.created_by, createdAt: Number(v.created_at) };
  }

  async versions(s: ScriptRow) {
    const rows = (await this.db('script_versions').where({ script_id: s.id }).orderBy('version', 'desc').select('version', 'note', 'created_by', 'created_at', 'checks')) as Pick<VersionRow, 'version' | 'note' | 'created_by' | 'created_at' | 'checks'>[];
    return rows.map((v) => ({ version: v.version, note: v.note, createdBy: v.created_by, createdAt: Number(v.created_at), blocked: blocking(json<ScriptCheck[]>(v.checks, [])).length > 0 }));
  }

  /** The script with its promotion state derived from its registry entry. */
  async view(s: ScriptRow) {
    const v = await this.version(s);
    const entry = s.registry_id ? await this.registry.get(s.tenant_id, s.registry_id) : undefined;
    let status = s.status;
    if (entry && (entry.status === 'published' || entry.status === 'deprecated') && status !== 'promoted') status = 'promoted';
    if (entry && entry.status === 'draft' && status === 'in_review') status = 'tested'; // rejected: back to the owner
    if (status !== s.status) await this.db('scripts').where({ id: s.id }).update({ status, updated_at: Date.now() });
    const lastRun = (await this.db('script_runs').where({ script_id: s.id }).orderBy('created_at', 'desc').first('id')) as { id: string } | undefined;
    return {
      id: s.id,
      name: s.name,
      language: s.language,
      label: s.label,
      status,
      version: s.version,
      workspaceId: s.workspace_id,
      source: v.source,
      limits: v.limits,
      checks: v.checks,
      blocked: blocking(v.checks).length > 0,
      registry: entry ? { id: entry.id, name: entry.name, version: entry.version, status: entry.status, reviewNote: entry.review_note } : null,
      lastRunId: lastRun?.id ?? null,
      createdAt: Number(s.created_at),
      updatedAt: Number(s.updated_at)
    };
  }

  // ---------- checks ----------

  /** The checks every version passes before it may run. */
  async checks(p: Principal, s: Pick<ScriptRow, 'id' | 'language' | 'label'>, source: string): Promise<ScriptCheck[]> {
    const out: ScriptCheck[] = [];
    const d = await this.guard().check({ tenantId: p.tenantId, workspaceId: p.workspaceId ?? null, checkpoint: 'script', text: source, label: s.label, principal: p, source: { kind: 'script', id: s.id }, meta: { language: s.language } });
    const tone = d.action === 'block' || d.action === 'require-approval' ? 'danger' : d.action === 'allow' || d.action === 'log' ? 'ok' : 'warn';
    out.push({ name: 'Script guardrail', result: d.action === 'allow' ? 'passed' : d.action === 'require-approval' ? 'needs approval' : d.action === 'block' ? 'blocked' : d.action, tone, detail: d.reason ?? (d.findings.length ? d.findings.map((f) => f.ruleName).join(', ') : 'No rule matched.') });
    const mods = blockedModules(s.language, source);
    out.push(mods.length ? { name: 'Blocked modules', result: 'blocked module', tone: 'danger', detail: `Line ${mods[0]!.line} uses ${mods[0]!.module}. Scripts have no network and cannot start processes${mods.length > 1 ? `; ${mods.length - 1} more` : ''}.`, line: mods[0]!.line } : { name: 'Blocked modules', result: 'clean', tone: 'ok', detail: 'No network or process modules.' });
    const secrets = scanSecrets(source);
    out.push(secrets.length ? { name: 'Secrets scan', result: `${secrets.length} finding${secrets.length === 1 ? '' : 's'}`, tone: 'danger', detail: `Line ${secrets[0]!.line}: ${secrets[0]!.what}. Pass secrets as references, never in source.`, line: secrets[0]!.line } : { name: 'Secrets scan', result: 'clean', tone: 'ok', detail: 'No credentials found.' });
    return out;
  }

  // ---------- writes ----------

  async create(p: Principal, input: { name: string; language: Language; source: string; label: Label; limits: ScriptLimits }): Promise<ScriptRow> {
    if (!clears(p.clearance, input.label)) throw forbidden('Above your clearance.', { step: 'clearance' });
    const ws = p.workspaceId ? ((await this.db('workspaces').where({ id: p.workspaceId }).first('label_ceiling')) as { label_ceiling: Label } | undefined) : undefined;
    if (ws && labelRank(input.label) > labelRank(ws.label_ceiling)) throw forbidden(`This workspace's ceiling is ${ws.label_ceiling}.`, { step: 'zone' });
    const q = this.db('scripts').where({ tenant_id: p.tenantId, name: input.name });
    if (p.workspaceId) q.andWhere({ workspace_id: p.workspaceId });
    else q.whereNull('workspace_id');
    if (await q.first('id')) throw conflict('A script with that name exists in this workspace.');
    const t = Date.now();
    const row: ScriptRow = { id: ulid(), tenant_id: p.tenantId, workspace_id: p.workspaceId ?? null, name: input.name, language: input.language, label: input.label, status: 'draft', version: 1, registry_id: null, created_by: p.userId, created_at: t, updated_at: t };
    await this.db('scripts').insert(row);
    await this.addVersion(p, row, 1, input.source, input.limits, 'Created');
    return row;
  }

  private async addVersion(p: Principal, s: ScriptRow, version: number, source: string, limits: ScriptLimits, note: string | null) {
    const id = ulid();
    const checks = await this.checks(p, s, source);
    await this.db('script_versions').insert({ id, script_id: s.id, version, source: await this.keys.seal(s.tenant_id, source, `script:${id}`), limits: JSON.stringify(limits), checks: JSON.stringify(checks), note, created_by: p.userId, created_at: Date.now() });
    return checks;
  }

  /** A new version (source and/or limits). A tested or promoted script goes back to draft until the new version runs cleanly. */
  async update(p: Principal, s: ScriptRow, input: { source?: string; limits?: ScriptLimits; label?: Label; note?: string | null }) {
    const cur = await this.version(s);
    if (input.label && !clears(p.clearance, input.label)) throw forbidden('Above your clearance.', { step: 'clearance' });
    if (input.label && labelRank(input.label) < labelRank(s.label)) throw conflict(`A script's label never goes down; it is ${s.label}.`);
    const version = s.version + 1;
    const label = input.label ?? s.label;
    const next = { ...s, label };
    await this.addVersion(p, next, version, input.source ?? cur.source, input.limits ?? cur.limits, input.note ?? 'Edited');
    await this.db('scripts').where({ id: s.id }).update({ version, label, status: s.status === 'promoted' || s.status === 'in_review' ? s.status : 'draft', updated_at: Date.now() });
    return { ...next, version };
  }

  /** Restores an old version as a new one (versions are never overwritten). */
  async restore(p: Principal, s: ScriptRow, version: number) {
    const old = await this.version(s, version);
    return this.update(p, s, { source: old.source, limits: old.limits, note: `Restored v${version}` });
  }

  async recheck(p: Principal, s: ScriptRow): Promise<ScriptCheck[]> {
    const v = await this.version(s);
    const checks = await this.checks(p, s, v.source);
    await this.db('script_versions').where({ script_id: s.id, version: s.version }).update({ checks: JSON.stringify(checks) });
    return checks;
  }

  // ---------- runs ----------

  /** Queues a run of the current version; refused before start when a check blocks it. */
  async run(p: Principal, s: ScriptRow, stdin: string | null) {
    const v = await this.version(s);
    const bad = blocking(v.checks);
    if (bad.length) throw new HttpProblem(409, 'Refused before start', `${bad[0]!.name}: ${bad[0]!.detail}`, { extensions: { checks: bad } });
    const id = ulid();
    const t = Date.now();
    await this.db('script_runs').insert({ id, tenant_id: s.tenant_id, script_id: s.id, version: s.version, job_id: null, state: 'queued', input: stdin ? await this.keys.seal(s.tenant_id, stdin, `script-run-input:${id}`) : null, stdout: null, stderr: null, exit_code: null, duration_ms: null, truncated: false, runner: this.runner.name, error: null, created_by: p.userId, created_at: t, finished_at: null });
    const job = await this.jobs.enqueue({ tenantId: s.tenant_id, type: 'script.run', payload: { runId: id }, createdBy: p.userId, maxAttempts: 1 });
    await this.db('script_runs').where({ id }).update({ job_id: job.id });
    return { runId: id, jobId: job.id };
  }

  private emit(userId: string | null, data: Record<string, unknown>): void {
    if (userId) this.bus.publish(TOPICS.runEvent, { userId, event: 'script.run', data });
  }

  private async execute(runId: string, signal: AbortSignal, progress: (pct: number, m?: string) => Promise<void>) {
    const r = (await this.db('script_runs').where({ id: runId }).first()) as RunRow | undefined;
    if (!r || r.state !== 'queued') return { skipped: true };
    const s = (await this.db('scripts').where({ id: r.script_id }).first()) as ScriptRow;
    const v = await this.versionRow(s.id, r.version);
    const source = await this.keys.open(s.tenant_id, v.source, `script:${v.id}`);
    const stdin = r.input ? await this.keys.open(s.tenant_id, r.input, `script-run-input:${r.id}`) : '';
    await this.db('script_runs').where({ id: r.id }).update({ state: 'running' });
    this.emit(r.created_by, { runId: r.id, scriptId: s.id, state: 'running' });
    await progress(20, `Starting the ${s.language} sandbox`);
    let res: RunResult;
    try {
      res = await this.runner.run({ id: r.id, language: s.language, source, stdin, limits: json<ScriptLimits>(v.limits, DEFAULT_LIMITS) }, signal);
    } catch (err) {
      const cancelled = signal.aborted;
      const msg = err instanceof RunnerUnavailable ? err.message : (err as Error).message;
      if (!cancelled) this.log.warn({ run: r.id, err: msg }, 'script run failed to execute');
      await this.db('script_runs').where({ id: r.id }).update({ state: cancelled ? 'cancelled' : 'failed', error: msg.slice(0, 1000), finished_at: Date.now() });
      this.emit(r.created_by, { runId: r.id, scriptId: s.id, state: cancelled ? 'cancelled' : 'failed', error: msg });
      if (cancelled) throw err;
      return { state: 'failed', error: msg };
    }
    const state = res.timedOut ? 'timeout' : res.exitCode === 0 ? 'succeeded' : 'failed';
    await this.db('script_runs').where({ id: r.id }).update({
      state,
      stdout: await this.keys.seal(s.tenant_id, res.stdout, `script-run-stdout:${r.id}`),
      stderr: await this.keys.seal(s.tenant_id, res.stderr, `script-run-stderr:${r.id}`),
      exit_code: res.exitCode,
      duration_ms: res.durationMs,
      truncated: res.truncated,
      finished_at: Date.now()
    });
    // A clean run of the current version makes a draft "tested", the step before promotion.
    if (state === 'succeeded') await this.db('scripts').where({ id: s.id, version: r.version, status: 'draft' }).update({ status: 'tested', updated_at: Date.now() });
    this.emit(r.created_by, { runId: r.id, scriptId: s.id, state, exitCode: res.exitCode });
    return { state, exitCode: res.exitCode, durationMs: res.durationMs };
  }

  async runView(p: Principal, runId: string) {
    const r = (await this.db('script_runs').where({ tenant_id: p.tenantId, id: runId }).first()) as RunRow | undefined;
    if (!r) throw notFound('Run');
    await this.get(p, r.script_id);
    const open = async (field: string, v: string | null) => (v ? this.keys.open(r.tenant_id, v, `${field}:${r.id}`) : null);
    return { id: r.id, scriptId: r.script_id, version: r.version, jobId: r.job_id, state: r.state, stdin: await open('script-run-input', r.input), stdout: await open('script-run-stdout', r.stdout), stderr: await open('script-run-stderr', r.stderr), exitCode: r.exit_code, durationMs: r.duration_ms, truncated: !!r.truncated, runner: r.runner, error: r.error, createdAt: Number(r.created_at), finishedAt: r.finished_at == null ? null : Number(r.finished_at) };
  }

  async runs(s: ScriptRow, limit = 20) {
    const rows = (await this.db('script_runs').where({ script_id: s.id }).orderBy('created_at', 'desc').limit(limit).select('id', 'version', 'state', 'exit_code', 'duration_ms', 'created_at', 'finished_at')) as Pick<RunRow, 'id' | 'version' | 'state' | 'exit_code' | 'duration_ms' | 'created_at' | 'finished_at'>[];
    return rows.map((r) => ({ id: r.id, version: r.version, state: r.state, exitCode: r.exit_code, durationMs: r.duration_ms, createdAt: Number(r.created_at), finishedAt: r.finished_at == null ? null : Number(r.finished_at) }));
  }

  // ---------- promotion ----------

  /** Submits a tested script as a draft registry tool, straight into review. */
  async promote(p: Principal, s: ScriptRow, input: { toolName: string; version: string; description: string; sideEffect: SideEffect; label: Label; inputSchema: JsonSchema; outputSchema: JsonSchema | null }): Promise<EntryRow> {
    if (s.status === 'in_review' || s.status === 'promoted') throw conflict(`${s.name} is already ${s.status === 'in_review' ? 'in review' : 'promoted'}.`);
    if (s.status !== 'tested') throw conflict('Run the current version once without errors before submitting it for promotion.');
    const v = await this.version(s);
    const bad = blocking(v.checks);
    if (bad.length) throw new HttpProblem(409, 'Refused', `${bad[0]!.name}: ${bad[0]!.detail}`, { extensions: { checks: bad } });
    if (labelRank(input.label) < labelRank(s.label)) throw conflict(`The tool's ceiling must be at least the script's label (${s.label}).`);
    const draft = await this.registry.create(p, { kind: 'tool', name: input.toolName, version: input.version, description: input.description, impl: 'script', sideEffect: input.sideEffect, label: input.label, inputSchema: input.inputSchema, outputSchema: input.outputSchema, definition: { scriptId: s.id, scriptName: s.name, version: s.version, language: s.language } });
    const submitted = await this.registry.submit(draft);
    await this.db('scripts').where({ id: s.id }).update({ status: 'in_review', registry_id: submitted.id, updated_at: Date.now() });
    return submitted;
  }

  /**
   * Runs a promoted script as a tool: the arguments go in as JSON on stdin, the result is the JSON on stdout.
   * Inline rather than queued, as the caller (chat or an agent step) waits for it.
   */
  async runAsTool(entry: EntryRow, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const def = entry.definition as { scriptId?: string; version?: number };
    const s = (await this.db('scripts').where({ id: def.scriptId ?? '' }).first()) as ScriptRow | undefined;
    if (!s) throw new Error('The script behind this tool no longer exists.');
    const v = await this.versionRow(s.id, Number(def.version));
    const source = await this.keys.open(s.tenant_id, v.source, `script:${v.id}`);
    const res = await this.runner.run({ id: ulid(), language: s.language, source, stdin: JSON.stringify(args), limits: json<ScriptLimits>(v.limits, DEFAULT_LIMITS) }, signal);
    if (res.timedOut) throw new Error(`The script stopped at its ${json<ScriptLimits>(v.limits, DEFAULT_LIMITS).timeoutSeconds} s limit.`);
    if (res.exitCode !== 0) throw new Error(`The script exited with ${res.exitCode}: ${res.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300)}`);
    const out = res.stdout.trim();
    try {
      return JSON.parse(out) as unknown;
    } catch {
      return { text: out };
    }
  }
}
