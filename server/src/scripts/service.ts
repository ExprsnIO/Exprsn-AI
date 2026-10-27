import { ulid } from 'ulid';
import type { Logger } from 'pino';
import { json, type Db } from '../db/knex.js';
import { clears, labelRank, type Label } from '../authz/labels.js';
import { authorize, type Principal } from '../authz/policy.js';
import { conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import { TOPICS, type Bus } from '../platform/bus.js';
import type { DataKeys } from '../platform/datakeys.js';
import type { JobQueue } from '../platform/jobs.js';
import type { Guardrails } from '../guardrails/types.js';
import { scanSecrets } from '../registry/checks.js';
import type { EntryRow, RegistryService, SideEffect } from '../registry/service.js';
import { validateAgainst, type JsonSchema } from '../registry/schema.js';
import type { ScriptRefInfo } from '../workflows/steps/kinds.js';
import type { ScriptStepOutcome, ScriptStepRunner } from '../workflows/steps/host.js';
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

/**
 * Imports, commands and functions that reach the network or (outside the shells, where starting programs is the
 * point) spawn processes. Scripts run with no network, so these are refused up front.
 */
const NET_CMDS = /(?:^|[\s;|&(`])(curl|wget|nc|ncat|netcat|socat|ssh|scp|sftp|rsync|telnet|ftp|nslookup|dig|ping)(?=\s|$)|(\/dev\/(?:tcp|udp))\//;
const BLOCKED: Record<Language, RegExp[]> = {
  python: [/^\s*(?:import|from)\s+(requests|urllib3?|http|httpx|aiohttp|socket|ftplib|smtplib|telnetlib|paramiko|subprocess|pty)\b/],
  javascript: [/\b(?:require\(\s*|from\s+|import\(\s*)['"](?:node:)?(http|https|http2|net|dgram|tls|child_process|cluster|worker_threads|undici|axios|node-fetch)['"]/, /(?:^|[^.\w])(fetch)\s*\(/],
  typescript: [/\b(?:require\(\s*|from\s+|import\(\s*)['"](?:node:)?(http|https|http2|net|dgram|tls|child_process|cluster|worker_threads|undici|axios|node-fetch)['"]/, /(?:^|[^.\w])(fetch)\s*\(/],
  bash: [NET_CMDS],
  sh: [NET_CMDS],
  perl: [/^\s*(?:use|require)\s+(IO::Socket[\w:]*|Socket|LWP[\w:]*|HTTP::\w+|Net::\w+|IPC::\w+)/, /(?:^|[^\w$@%])(system|exec|qx)\s*[({'"]/, /(`)[^`]*`/],
  ruby: [/\brequire\s*\(?\s*['"](socket|net\/\w+|open-uri|open3|resolv)['"]/, /(?:^|[^.\w])(system|exec|spawn|IO\.popen|Open3)\b/, /(`)[^`]*`/],
  tcl: [/(?:^|[\s[;])(socket|exec|open\s+["{]?\|)/, /package\s+require\s+(http|tls)\b/],
  lua: [/\brequire\s*\(?\s*['"](socket|http|ssl)\S*['"]/, /\b(os\.execute|io\.popen)\b/],
  php: [/\b(fsockopen|pfsockopen|stream_socket_client|socket_create|curl_init|curl_exec|exec|shell_exec|system|passthru|proc_open|popen)\s*\(/, /\b(?:file_get_contents|fopen|file|readfile)\s*\(\s*['"](https?|ftp):\/\//, /(`)[^`]*`/],
  awk: [/(\|&)|(\/inet\/)/],
  jq: [],
  sql: [/^\s*(\.(?:shell|system|load|open|output|once|import|save|backup|restore|read|cd|excel))\b/, /\b(load_extension|writefile|readfile|edit)\s*\(/i],
  powershell: [/\b(Invoke-WebRequest|Invoke-RestMethod|iwr|irm|Start-Process|New-PSSession|Enter-PSSession|Invoke-Command|Net\.WebClient|Net\.Http\.HttpClient|Net\.Sockets\.\w+|Diagnostics\.Process)\b/i]
};

export function blockedModules(language: Language, source: string): { module: string; line: number }[] {
  const out: { module: string; line: number }[] = [];
  source.split('\n').forEach((l, i) => {
    for (const re of BLOCKED[language]) {
      const m = re.exec(l);
      if (m) out.push({ module: m.slice(1).find((x) => x != null) ?? m[0], line: i + 1 });
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
export class ScriptService implements ScriptStepRunner {
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

  /**
   * The scripts of the caller's workspace and the tenant-wide ones (no workspace: what setup and tenant admins
   * create outside any workspace), which every workspace of the tenant sees, as it sees tenant-wide registry entries.
   */
  async list(p: Principal): Promise<ScriptRow[]> {
    const q = this.db('scripts').where({ tenant_id: p.tenantId });
    if (p.workspaceId) q.andWhere((w) => w.where({ workspace_id: p.workspaceId }).orWhereNull('workspace_id'));
    else q.whereNull('workspace_id');
    const rows = (await q.orderBy('name')) as ScriptRow[];
    return rows.filter((r) => clears(p.clearance, r.label));
  }

  async get(p: Principal, id: string): Promise<ScriptRow> {
    const s = (await this.db('scripts').where({ tenant_id: p.tenantId, id }).first()) as ScriptRow | undefined;
    if (!s || (s.workspace_id != null && s.workspace_id !== (p.workspaceId ?? null))) throw notFound('Script');
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
    out.push(mods.length ? { name: 'Blocked modules', result: 'blocked module', tone: 'danger', detail: `Line ${mods[0]!.line} uses ${mods[0]!.module}. Scripts have no network${s.language === 'bash' || s.language === 'sh' ? '' : ' and cannot start processes'}${mods.length > 1 ? `; ${mods.length - 1} more` : ''}.`, line: mods[0]!.line } : { name: 'Blocked modules', result: 'clean', tone: 'ok', detail: s.language === 'bash' || s.language === 'sh' ? 'No network commands.' : 'No network or process modules.' });
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

  // ---------- workflow script steps ----------

  /** The script a workflow in `scope` may name (its workspace's, or tenant-wide), by id or name; the workspace's own wins. */
  private async inScope(scope: { tenantId: string; workspaceId: string | null }, ref: string): Promise<ScriptRow | undefined> {
    const q = this.db('scripts').where({ tenant_id: scope.tenantId }).andWhere((w) => w.where({ id: ref }).orWhere({ name: ref }));
    if (scope.workspaceId) q.andWhere((w) => w.where({ workspace_id: scope.workspaceId }).orWhereNull('workspace_id'));
    else q.whereNull('workspace_id');
    const rows = (await q) as ScriptRow[];
    return rows.find((r) => r.id === ref) ?? rows.find((r) => r.workspace_id != null) ?? rows[0];
  }

  /** The version the script's published registry tool pins (reviewed by a tool admin), with that tool, or null. */
  private async reviewed(s: ScriptRow): Promise<{ version: number; entry: EntryRow } | null> {
    const entry = s.registry_id ? await this.registry.get(s.tenant_id, s.registry_id) : undefined;
    if (!entry || (entry.status !== 'published' && entry.status !== 'deprecated') || entry.approved_hash !== entry.schema_hash) return null;
    const def = entry.definition as { scriptId?: string; version?: number };
    return def.scriptId === s.id && Number.isInteger(Number(def.version)) ? { version: Number(def.version), entry } : null;
  }

  /**
   * A script step's script as seen from a workflow's scope, and the version that may run unattended: without a pinned
   * version, the one its published tool pins (reviewed); a pinned version must be that one, or pass its checks and
   * have run cleanly at least once (tested). A version its checks refuse never runs.
   */
  async refInfo(scope: { tenantId: string; workspaceId: string | null }, ref: string, version?: number): Promise<ScriptRefInfo | { missing: string }> {
    const s = await this.inScope(scope, ref);
    if (!s) return { missing: 'is not a script in this workspace' };
    const rev = await this.reviewed(s);
    const v = version ?? rev?.version;
    if (v == null) return { missing: 'has no reviewed version: promote it to a registry tool, or pin a version that ran cleanly' };
    const row = (await this.db('script_versions').where({ script_id: s.id, version: v }).first('checks')) as Pick<VersionRow, 'checks'> | undefined;
    if (!row) return { missing: `has no version ${v}` };
    const bad = blocking(json<ScriptCheck[]>(row.checks, []));
    if (bad.length) return { missing: `version ${v} is refused by its checks (${bad[0]!.name}: ${bad[0]!.result})` };
    const base = { id: s.id, name: s.name, label: s.label, version: v };
    if (rev && rev.version === v) {
      const e = rev.entry;
      return { ...base, basis: 'reviewed', tool: e.name, ceiling: e.label, sideEffect: e.side_effect ?? 'read', confirm: e.confirm, inputSchema: e.input_schema, outputSchema: e.output_schema };
    }
    const clean = await this.db('script_runs').where({ script_id: s.id, version: v, state: 'succeeded' }).first('id');
    if (!clean) return { missing: `version ${v} has not run cleanly yet; run it once on the Scripts screen` };
    return { ...base, basis: 'tested', tool: null, ceiling: null, sideEffect: 'read', confirm: 'never', inputSchema: null, outputSchema: null };
  }

  /**
   * Runs a script step's version as `p` (the workflow run's owner): the same sandbox, image and limits as any run of
   * it, after the `tool-call` guardrail checkpoint on the arguments. A tested (not reviewed) version needs the owner to
   * hold `scripts:run`; a reviewed one that writes or always asks runs only behind an Approval step. Recorded as a
   * script run (sealed input and output) so it shows in the script's history.
   */
  async runForStep(p: Principal, info: ScriptRefInfo, rawArgs: Record<string, unknown>, ctx: { label: Label; approved: boolean; source: { kind: string; id: string }; signal?: AbortSignal }): Promise<ScriptStepOutcome> {
    const fail = (error: string, type: 'failed' | 'rejected' | 'label' | 'timeout' = 'failed', blocked = false, run: string | null = null): ScriptStepOutcome => ({ ok: false, error, type, blocked, run });
    const s = (await this.db('scripts').where({ tenant_id: p.tenantId, id: info.id }).first()) as ScriptRow | undefined;
    if (!s) return fail(`Script ${info.name} no longer exists.`);
    if (!clears(p.clearance, s.label)) return fail(`Blocked by label ceiling: ${s.name} is ${s.label}, above the run owner's clearance ${p.clearance}.`, 'label', true);
    if (info.basis === 'tested' && !authorize(p, 'scripts:run').allow) return fail(`Rejected by policy: running ${s.name} version ${info.version}, which has no reviewed tool, needs the run's owner to hold scripts:run.`, 'rejected');
    let args = rawArgs;
    const invalid = validateAgainst(info.inputSchema as JsonSchema | null, args);
    if (invalid.length) return fail(`The arguments do not match the input schema of ${info.tool ?? s.name}: ${invalid.slice(0, 3).join('; ')}.`);
    const d = await this.guard().check({ tenantId: p.tenantId, workspaceId: p.workspaceId ?? null, checkpoint: 'tool-call', text: JSON.stringify({ tool: info.tool ?? `script:${s.name}`, arguments: args }), label: ctx.label, principal: p, source: ctx.source, meta: { script: s.name, version: info.version, impl: 'script', sideEffect: info.sideEffect, confirm: info.confirm, ...(info.ceiling ? { ceiling: info.ceiling, toolLabel: info.ceiling } : {}) } });
    if (d.action === 'block') return fail(`Blocked by guardrails: the tool-call checkpoint${d.reason ? `: ${d.reason}` : ''}.`, 'rejected');
    if (d.action === 'redact') {
      try {
        args = (JSON.parse(d.text) as { arguments?: Record<string, unknown> }).arguments ?? args;
      } catch {
        return fail('Blocked by guardrails: the tool-call checkpoint redacted the arguments beyond use.', 'rejected');
      }
    }
    if (!ctx.approved && (d.action === 'require-approval' || info.sideEffect !== 'read' || info.confirm === 'always')) {
      return fail(`Rejected by policy: ${s.name} ${d.action === 'require-approval' ? 'is held by the tool-call guardrail' : `is a ${info.sideEffect} tool`} and runs only behind an Approval step.`, 'rejected');
    }
    const v = await this.versionRow(s.id, info.version);
    if (blocking(json<ScriptCheck[]>(v.checks, [])).length) return fail(`Version ${info.version} of ${s.name} is refused by its checks.`, 'rejected');
    const source = await this.keys.open(s.tenant_id, v.source, `script:${v.id}`);
    const limits = json<ScriptLimits>(v.limits, DEFAULT_LIMITS);
    const stdin = JSON.stringify(args);
    const id = ulid();
    await this.db('script_runs').insert({ id, tenant_id: s.tenant_id, script_id: s.id, version: info.version, job_id: null, state: 'running', input: await this.keys.seal(s.tenant_id, stdin, `script-run-input:${id}`), stdout: null, stderr: null, exit_code: null, duration_ms: null, truncated: false, runner: this.runner.name, error: null, created_by: p.userId, created_at: Date.now(), finished_at: null });
    let res: RunResult;
    try {
      res = await this.runner.run({ id, language: s.language, source, stdin, limits }, ctx.signal);
    } catch (err) {
      const cancelled = !!ctx.signal?.aborted;
      const msg = (err as Error).message;
      await this.db('script_runs').where({ id }).update({ state: cancelled ? 'cancelled' : 'failed', error: msg.slice(0, 1000), finished_at: Date.now() });
      if (cancelled) throw err;
      return fail(`${s.name} could not run: ${msg}`, 'failed', false, id);
    }
    const state = res.timedOut ? 'timeout' : res.exitCode === 0 ? 'succeeded' : 'failed';
    await this.db('script_runs').where({ id }).update({ state, stdout: await this.keys.seal(s.tenant_id, res.stdout, `script-run-stdout:${id}`), stderr: await this.keys.seal(s.tenant_id, res.stderr, `script-run-stderr:${id}`), exit_code: res.exitCode, duration_ms: res.durationMs, truncated: res.truncated, finished_at: Date.now() });
    if (res.timedOut) return fail(`${s.name} stopped at its ${limits.timeoutSeconds} s limit.`, 'timeout', false, id);
    if (res.exitCode !== 0) return fail(`${s.name} exited with ${res.exitCode}: ${res.stderr.trim().split('\n').slice(-3).join(' ').slice(0, 300)}`, 'failed', false, id);
    const out = res.stdout.trim();
    let value: unknown;
    try {
      value = JSON.parse(out) as unknown;
    } catch {
      value = { text: out };
    }
    const output = value && typeof value === 'object' && !Array.isArray(value) ? value : { result: value };
    const valid = info.outputSchema ? validateAgainst(info.outputSchema as JsonSchema, output).length === 0 : null;
    return { ok: true, output, run: id, exitCode: res.exitCode, durationMs: res.durationMs, truncated: res.truncated, valid };
  }

  /**
   * Scripts the workflow editor offers a script step, within the caller's clearance: each with its reviewed version
   * (and tool) and the versions that may be pinned (checks pass and a clean run).
   */
  async forWorkflows(p: Principal) {
    const out = [];
    for (const s of await this.list(p)) {
      const rev = await this.reviewed(s);
      const runs = (await this.db('script_runs').where({ script_id: s.id, state: 'succeeded' }).distinct('version')) as { version: number }[];
      const clean = new Set(runs.map((r) => Number(r.version)));
      const versions = (await this.versions(s)).filter((v) => !v.blocked && (clean.has(v.version) || v.version === rev?.version)).map((v) => ({ version: v.version, note: v.note, reviewed: v.version === rev?.version }));
      out.push({ id: s.id, name: s.name, language: s.language, label: s.label, status: s.status, latest: s.version, reviewed: rev ? { version: rev.version, tool: rev.entry.name, sideEffect: rev.entry.side_effect ?? 'read', confirm: rev.entry.confirm, ceiling: rev.entry.label, inputSchema: rev.entry.input_schema, outputSchema: rev.entry.output_schema } : null, versions });
    }
    return out;
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
