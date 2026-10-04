import { ulid } from 'ulid';
import type { Logger } from 'pino';
import { json, type Db } from '../db/knex.js';
import { isLabel, labelRank, type Label } from '../authz/labels.js';
import type { Gateway } from '../gateway/gateway.js';
import type { DataKeys } from '../platform/datakeys.js';
import type { JobContext, JobQueue } from '../platform/jobs.js';
import type { ClassifierService } from './classifiers.js';
import { detectPii, detectSecrets } from './detectors.js';
import type { FlagService, Severity } from './flags.js';
import { complete, guardMessages, GUARD_CATEGORIES, parseGuardVerdict } from './model.js';
import { compilePattern, matchAll } from './regex.js';
import { actionRank, type Rule } from './rules.js';
import type { ActiveRule, RuleSetRow, RuleSetService } from './sets.js';
import type { GuardAction, GuardDecision, GuardFinding, GuardInput, Guardrails } from './types.js';

/** Recorded inputs are kept this long, for shadow replay and rule statistics. */
export const RETENTION_DAYS = 7;
const MAX_RECORDED_CHARS = 200_000;
const MAX_SPANS_PER_RULE = 20;
const SHADOW_SAMPLE = 100;

/** What one rule made of one text. */
export interface RuleResult {
  hit: boolean;
  spans: [number, number][];
  score: number | null;
  /** What the score measures, for the live test ("confidence", "match", "tokens"…). */
  unit: string;
  detail: string | null;
  /** Set when the mechanism could not answer; the rule's onError then decides. */
  error: string | null;
  ms: number;
}

/** A finding as recorded: the public GuardFinding plus where it came from. */
interface Recorded extends GuardFinding {
  version: number;
  pending: boolean;
  error?: 'closed' | 'open' | 'shadow';
}

const WORDS: Record<GuardAction, string> = { allow: 'allowed', log: 'logged', warn: 'warned', flag: 'flagged', redact: 'redacted', 'require-approval': 'held for approval', block: 'blocked' };

/**
 * The guardrail engine behind every checkpoint. It evaluates every enabled rule that applies (platform baseline,
 * tenant, workspace and agent sets; drafts under review in shadow), and the effective action is the most severe
 * enforced finding: the most restrictive result wins, so no level can relax another. Shadow findings are recorded
 * and never change the outcome. A rule whose mechanism fails holds the turn when it fails closed, and also when the
 * turn is confidential or above or can call tools; elsewhere it falls open and the decision is flagged.
 * Every check is recorded with the inspected text sealed, for replay and statistics.
 */
export class GuardrailEngine implements Guardrails {
  private readonly patterns = new Map<string, ReturnType<typeof compilePattern>>();

  constructor(
    private readonly db: Db,
    private readonly keys: DataKeys,
    private readonly gateway: Gateway,
    private readonly sets: RuleSetService,
    private readonly classifiers: ClassifierService,
    private readonly flags: FlagService,
    private readonly log: Logger,
    jobs: JobQueue
  ) {
    jobs.register('guardrails.replay', (p, ctx) => this.replayJob(String(p.tenantId ?? ctx.job.tenant_id), String(p.setId), Number(p.version), ctx), { timeoutMs: 2 * 60 * 60_000 });
    jobs.register('guardrails.sweep', async (p, ctx) => {
      const tenantId = String(p.tenantId ?? ctx.job.tenant_id);
      const breached = await this.flags.sweep(tenantId);
      const purged = await this.db('guard_decisions').where({ tenant_id: tenantId }).andWhere('created_at', '<', Date.now() - RETENTION_DAYS * 86_400_000).delete();
      return { breached, purged };
    });
  }

  // ---------- one rule ----------

  private compiled(pattern: string) {
    let c = this.patterns.get(pattern);
    if (!c) {
      c = compilePattern(pattern);
      if (this.patterns.size > 500) this.patterns.clear();
      this.patterns.set(pattern, c);
    }
    return c;
  }

  /** Runs one rule's mechanism on a text. Never throws: failures come back as `error`. */
  async evaluate(rule: Rule, input: Pick<GuardInput, 'tenantId' | 'checkpoint' | 'text' | 'label' | 'principal' | 'meta'>): Promise<RuleResult> {
    const t0 = performance.now();
    const done = (r: Omit<RuleResult, 'ms'>): RuleResult => ({ ...r, ms: Math.round((performance.now() - t0) * 100) / 100 });
    const m = rule.mechanism;
    const meta = input.meta ?? {};
    try {
      switch (m.kind) {
        case 'pattern': {
          const c = this.compiled(m.pattern);
          if (!c.ok) throw new Error(`pattern does not compile: ${c.error.msg}`);
          const spans = matchAll(c.re, input.text);
          return done({ hit: spans.length > 0, spans, score: spans.length ? 1 : 0, unit: 'match', detail: spans.length ? `${spans.length} match${spans.length === 1 ? '' : 'es'}` : null, error: null });
        }
        case 'pii':
        case 'secrets': {
          const found = (m.kind === 'pii' ? detectPii(input.text, m.detectors) : detectSecrets(input.text, m.detectors)).filter((d) => d.score >= m.threshold);
          const best = found.reduce((a, d) => Math.max(a, d.score), 0);
          return done({ hit: found.length > 0, spans: found.map((d) => d.span), score: found.length ? best : 0, unit: 'confidence', detail: found.length ? [...new Set(found.map((d) => d.kind))].join(', ') : null, error: null });
        }
        case 'label': {
          const ceiling: Label | null = m.against === 'clearance' ? (input.principal?.clearance ?? null) : m.against === 'ceiling' ? (isLabel(meta.ceiling) ? meta.ceiling : null) : null;
          if (m.against === 'fixed') {
            const hit = labelRank(input.label) >= labelRank(m.label!);
            return done({ hit, spans: [], score: null, unit: 'label', detail: hit ? `${input.label} at or above ${m.label}` : null, error: null });
          }
          if (!ceiling) return done({ hit: false, spans: [], score: null, unit: 'label', detail: `no ${m.against} given at this checkpoint`, error: null });
          const hit = labelRank(input.label) > labelRank(ceiling);
          return done({ hit, spans: [], score: null, unit: 'label', detail: hit ? `${input.label} above ${m.against} ${ceiling}` : null, error: null });
        }
        case 'budget': {
          const value = m.metric === 'chars' ? input.text.length : m.metric === 'steps' ? Number(meta.steps ?? 0) : Number(meta.tokens ?? Math.ceil(input.text.length / 4));
          return done({ hit: value > m.max, spans: [], score: value, unit: m.metric, detail: value > m.max ? `${value} ${m.metric}, over ${m.max}` : null, error: null });
        }
        case 'allow-list': {
          const allowed = (host: string) => m.values.some((v) => host === v || host.endsWith(`.${v}`));
          const spans: [number, number][] = [];
          const hosts = new Set<string>();
          const re = /\bhttps?:\/\/([a-z0-9.-]+)(?::\d+)?[^\s<>"')]*/gi;
          for (let x = re.exec(input.text); x; x = re.exec(input.text)) {
            const host = x[1]!.toLowerCase();
            if (!allowed(host)) {
              hosts.add(host);
              spans.push([x.index, x.index + x[0].length]);
            }
          }
          for (const d of Array.isArray(meta.domains) ? meta.domains : []) if (typeof d === 'string' && !allowed(d.toLowerCase())) hosts.add(d.toLowerCase());
          return done({ hit: hosts.size > 0, spans, score: hosts.size, unit: 'domains', detail: hosts.size ? [...hosts].slice(0, 10).join(', ') : null, error: null });
        }
        case 'meta': {
          const v = meta[m.key];
          const values = (Array.isArray(v) ? v : [v]).filter((x) => x != null).map(String);
          const hit = values.some((x) => m.values.includes(x));
          return done({ hit, spans: [], score: null, unit: m.key, detail: hit ? `${m.key}: ${values.join(', ')}` : null, error: null });
        }
        case 'classifier': {
          const c = await this.classifiers.get(input.tenantId, m.classifier);
          if (!c) throw new Error(`classifier ${m.classifier} does not exist`);
          const r = await this.classifiers.score(input.tenantId, c, input.text, input.label);
          const score = r.scores[m.label];
          if (score === undefined) throw new Error(`classifier ${m.classifier} has no label ${m.label}`);
          const thr = m.threshold ?? c.config.labels.find((l) => l.label === m.label)?.threshold ?? 0.5;
          const hit = score > 0 && score >= thr;
          return done({ hit, spans: hit ? r.spans.filter((d) => d.kind === m.label).map((d) => d.span) : [], score, unit: `${m.label} score`, detail: hit ? `${m.label} ${score.toFixed(2)} at threshold ${thr.toFixed(2)}` : null, error: null });
        }
        case 'guard-model': {
          const prompt = typeof meta.prompt === 'string' ? meta.prompt : undefined;
          const out = await complete(this.gateway, input.tenantId, m.profile, input.label, guardMessages(input.text, input.checkpoint === 'model-output', prompt));
          const v = parseGuardVerdict(out.text);
          const cats = m.categories.length ? v.categories.filter((c) => m.categories.includes(c)) : v.categories;
          const hit = !v.safe && (m.categories.length === 0 || cats.length > 0);
          return done({ hit, spans: [], score: hit ? 1 : 0, unit: 'verdict', detail: v.safe ? 'safe' : `unsafe: ${(cats.length ? cats : v.categories).map((c) => `${c} ${GUARD_CATEGORIES[c] ?? ''}`.trim()).join(', ') || 'no category'}`, error: null });
        }
      }
    } catch (err) {
      return done({ hit: false, spans: [], score: null, unit: 'error', detail: null, error: (err as Error).message.slice(0, 300) });
    }
  }

  // ---------- a checkpoint ----------

  async check(input: GuardInput): Promise<GuardDecision> {
    const t0 = performance.now();
    const agent = typeof input.meta?.agent === 'string' ? input.meta.agent : null;
    const active = (await this.sets.forCheck(input.tenantId, input.workspaceId, agent)).filter((a) => a.rule.enabled && a.rule.checkpoint === input.checkpoint);
    const results = await Promise.all(active.map(async (a) => ({ a, r: await this.evaluate(a.rule, input) })));
    // Where a failure must not fall open: confidential and above, and turns that can call tools.
    const sensitive = labelRank(input.label) >= labelRank('confidential') || input.checkpoint === 'tool-call' || input.meta?.tools === true;
    const findings: Recorded[] = [];
    const timings: Record<string, number> = {};
    for (const { a, r } of results) {
      timings[`${a.set.id}/${a.rule.id}`] = r.ms;
      const base = { ruleId: a.rule.id, ruleName: a.rule.name, setId: a.set.id, version: a.version, pending: a.pending };
      const shadow = a.rule.stage === 'shadow';
      if (r.error) {
        if (shadow) findings.push({ ...base, action: a.rule.action, stage: 'shadow', detail: `unavailable: ${r.error}`, error: 'shadow' });
        else if (a.rule.onError === 'closed' || sensitive) findings.push({ ...base, action: 'require-approval', stage: 'enforce', detail: `unavailable: ${r.error}`, error: 'closed' });
        else findings.push({ ...base, action: 'flag', stage: 'enforce', detail: `fell open: ${r.error}`, error: 'open' });
        continue;
      }
      if (!r.hit) continue;
      const stage = shadow ? 'shadow' : 'enforce';
      const spans = r.spans.slice(0, MAX_SPANS_PER_RULE);
      if (!spans.length) findings.push({ ...base, action: a.rule.action, stage, ...(r.score != null ? { score: r.score } : {}), ...(r.detail ? { detail: r.detail } : {}) });
      for (const span of spans) findings.push({ ...base, action: a.rule.action, stage, span, ...(r.score != null ? { score: r.score } : {}), ...(r.detail ? { detail: r.detail } : {}) });
    }
    const enforced = findings.filter((f) => f.stage === 'enforce');
    const action = enforced.reduce<GuardAction>((acc, f) => (actionRank(f.action) > actionRank(acc) ? f.action : acc), 'allow');
    const text = action === 'redact' ? redact(input.text, enforced.filter((f) => f.action === 'redact')) : input.text;
    const reason = this.reason(action, enforced);
    const decision: GuardDecision = { action, text, findings: findings.map(publicFinding), ...(reason ? { reason } : {}) };
    const latency = Math.round(performance.now() - t0);
    try {
      await this.record(input, decision, findings, timings, latency, active);
    } catch (err) {
      // Recording is for replay and review; a failure to record never changes the decision.
      this.log.error({ err, checkpoint: input.checkpoint }, 'guardrail decision not recorded');
    }
    return decision;
  }

  /** Rule kinds that answer from the text alone, with no model or classifier call: safe to run on every sentence. */
  static readonly DETERMINISTIC = new Set(['pattern', 'pii', 'secrets', 'allow-list', 'label', 'budget', 'meta']);

  /**
   * The streaming screen (Sprint 12): the enforced deterministic rules at the checkpoint, resolved once for the whole
   * stream. The returned function evaluates them on the text so far; nothing is recorded (the full `check` on the
   * finished text records the decision), and a rule that errors is skipped here and decided by that full check.
   */
  async streamScreen(input: Omit<GuardInput, 'text'>): Promise<((text: string) => Promise<GuardDecision>) | null> {
    const agent = typeof input.meta?.agent === 'string' ? input.meta.agent : null;
    const active = (await this.sets.forCheck(input.tenantId, input.workspaceId, agent)).filter((a) => a.rule.enabled && a.rule.stage === 'enforce' && a.rule.checkpoint === input.checkpoint && GuardrailEngine.DETERMINISTIC.has(a.rule.mechanism.kind));
    if (!active.length) return null;
    return async (text: string) => {
      const findings: GuardFinding[] = [];
      for (const a of active) {
        const r = await this.evaluate(a.rule, { ...input, text });
        if (r.error || !r.hit) continue;
        const base = { ruleId: a.rule.id, ruleName: a.rule.name, setId: a.set.id, action: a.rule.action, stage: 'enforce' as const, ...(r.score != null ? { score: r.score } : {}), ...(r.detail ? { detail: r.detail } : {}) };
        if (!r.spans.length) findings.push(base);
        for (const span of r.spans.slice(0, MAX_SPANS_PER_RULE)) findings.push({ ...base, span });
      }
      const action = findings.reduce<GuardAction>((acc, f) => (actionRank(f.action) > actionRank(acc) ? f.action : acc), 'allow');
      const reason = this.reason(action, findings as Recorded[]);
      return { action, text: action === 'redact' ? redact(text, findings.filter((f) => f.action === 'redact')) : text, findings, ...(reason ? { reason } : {}) };
    };
  }

  /**
   * The model half of the streaming screen (Sprint 16): the enforced rules the deterministic screen leaves out (guard
   * model, classifiers), resolved once. The returned function runs them together on the text so far and records
   * nothing. A rule that cannot run makes the function reject when it would fail closed (the caller stops releasing and
   * leaves the decision to the full check); one that would fail open is skipped.
   */
  async streamModelScreen(input: Omit<GuardInput, 'text'>): Promise<((text: string) => Promise<GuardDecision>) | null> {
    const agent = typeof input.meta?.agent === 'string' ? input.meta.agent : null;
    const active = (await this.sets.forCheck(input.tenantId, input.workspaceId, agent)).filter((a) => a.rule.enabled && a.rule.stage === 'enforce' && a.rule.checkpoint === input.checkpoint && !GuardrailEngine.DETERMINISTIC.has(a.rule.mechanism.kind));
    if (!active.length) return null;
    const sensitive = labelRank(input.label) >= labelRank('confidential') || input.checkpoint === 'tool-call' || input.meta?.tools === true;
    return async (text: string) => {
      const results = await Promise.all(active.map(async (a) => ({ a, r: await this.evaluate(a.rule, { ...input, text }) })));
      const findings: Recorded[] = [];
      for (const { a, r } of results) {
        const base = { ruleId: a.rule.id, ruleName: a.rule.name, setId: a.set.id, version: a.version, pending: a.pending, stage: 'enforce' as const };
        // A rule that cannot run here stops release while streaming; the full check on the finished answer then
        // decides with the rule's own onError (and records it), so a busy guard model never holds an answer by itself.
        if (r.error) {
          if (a.rule.onError === 'closed' || sensitive) throw new Error(`${a.rule.name}: ${r.error}`);
          continue;
        }
        if (!r.hit) continue;
        const extra = { ...(r.score != null ? { score: r.score } : {}), ...(r.detail ? { detail: r.detail } : {}) };
        if (!r.spans.length) findings.push({ ...base, action: a.rule.action, ...extra });
        for (const span of r.spans.slice(0, MAX_SPANS_PER_RULE)) findings.push({ ...base, action: a.rule.action, span, ...extra });
      }
      const action = findings.reduce<GuardAction>((acc, f) => (actionRank(f.action) > actionRank(acc) ? f.action : acc), 'allow');
      const reason = this.reason(action, findings);
      return { action, text: action === 'redact' ? redact(text, findings.filter((f) => f.action === 'redact')) : text, findings: findings.map(publicFinding), ...(reason ? { reason } : {}) };
    };
  }

  private reason(action: GuardAction, enforced: Recorded[]): string | undefined {
    if (action !== 'block' && action !== 'require-approval' && action !== 'redact') return undefined;
    const f = enforced.find((x) => x.action === action)!;
    if (f.error === 'closed') return `A guardrail check could not run (${f.ruleName}: ${f.detail?.replace(/^unavailable: /, '')}), so this is held rather than let through.`;
    return `${action === 'redact' ? 'Redacted' : action === 'block' ? 'Blocked' : 'Held for approval'} by the guardrail "${f.ruleName}"${f.detail ? ` (${f.detail})` : ''}.`;
  }

  private async record(input: GuardInput, decision: GuardDecision, findings: Recorded[], timings: Record<string, number>, latency: number, active: ActiveRule[]): Promise<void> {
    const id = ulid();
    const text = input.text.slice(0, MAX_RECORDED_CHARS);
    await this.db('guard_decisions').insert({
      id,
      tenant_id: input.tenantId,
      workspace_id: input.workspaceId,
      user_id: input.principal?.userId ?? null,
      checkpoint: input.checkpoint,
      label: input.label,
      action: decision.action,
      text: await this.keys.seal(input.tenantId, text, `guard:${id}`),
      meta: input.meta ? JSON.stringify(scalarMeta(input.meta)) : null,
      findings: findings.length ? JSON.stringify(findings) : null,
      timings: JSON.stringify(timings),
      source_kind: input.source?.kind ?? null,
      source_id: input.source?.id ?? null,
      latency_ms: latency,
      created_at: Date.now()
    });
    // Sprint 26 (B-1901): a moderation check files one flag per object itself, so the engine files none for it.
    if (input.meta?.moderation === true) return;
    // Flags: every rule whose enforced action is flag, every fail-open decision, and a sample of shadow findings.
    const byRule = new Map<string, Recorded>();
    for (const f of findings) {
      const key = `${f.setId}/${f.ruleId}/${f.stage}`;
      if (!byRule.has(key)) byRule.set(key, f);
    }
    const conversationId = typeof input.meta?.conversationId === 'string' ? input.meta.conversationId : null;
    const actor = { user: input.principal?.userId ?? null, name: input.principal?.displayName ?? null, via: typeof input.meta?.via === 'string' ? input.meta.via : input.checkpoint };
    for (const f of byRule.values()) {
      const a = active.find((x) => x.set.id === f.setId && x.rule.id === f.ruleId && x.pending === f.pending)!;
      const failOpen = f.error === 'open';
      const shadowSample = f.stage === 'shadow' && !f.error && actionRank(a.rule.action) >= actionRank('flag') && (await this.flags.openShadowFlags(input.tenantId, f.setId!, f.ruleId)) < SHADOW_SAMPLE;
      if (!(f.stage === 'enforce' && (f.action === 'flag' || failOpen)) && !shadowSample) continue;
      const severity: Severity = shadowSample ? 'low' : a.rule.severity;
      await this.flags.create({
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        kind: failOpen ? 'fail-open' : 'rule',
        checkpoint: input.checkpoint,
        ruleId: f.ruleId,
        ruleName: f.stage === 'shadow' ? `${f.ruleName} (shadow)` : f.ruleName,
        setId: f.setId ?? null,
        setName: a.set.name,
        setVersion: f.version,
        stage: f.stage,
        action: failOpen ? a.rule.action : f.action,
        severity,
        label: input.label,
        text: input.text,
        span: f.span ?? null,
        note: failOpen ? `The rule could not run (${f.detail?.replace(/^fell open: /, '')}) and let this through under onError: allow.` : f.stage === 'shadow' ? `Shadow rule: nothing was ${WORDS[a.rule.action]} for the user. Your decision feeds the false-positive count used for promotion.` : f.detail ? `Matched: ${f.detail}.` : null,
        actor,
        source: input.source ?? null,
        conversationId
      });
    }
  }

  // ---------- status, statistics ----------

  /** Guard-model and classifier failures of the last hour: held turns and fail-open decisions. */
  async status(tenantId: string) {
    const since = Date.now() - 3_600_000;
    const rows = (await this.db('guard_decisions').where({ tenant_id: tenantId }).andWhere('created_at', '>=', since).andWhere('findings', 'like', '%"error"%').orderBy('created_at', 'desc').limit(1000).select('findings', 'created_at')) as { findings: string; created_at: number }[];
    let held = 0;
    let failOpen = 0;
    let first: number | null = null;
    let last: { at: number; rule: string; detail: string } | null = null;
    for (const r of rows) {
      const fs = json<Recorded[]>(r.findings, []).filter((f) => f.error && f.error !== 'shadow');
      if (!fs.length) continue;
      if (fs.some((f) => f.error === 'closed')) held++;
      if (fs.some((f) => f.error === 'open')) failOpen++;
      first = Number(r.created_at);
      last ??= { at: Number(r.created_at), rule: fs[0]!.ruleName, detail: fs[0]!.detail ?? '' };
    }
    return { degraded: held + failOpen > 0, since: first, held, failOpen, last };
  }

  /** Per rule of a set over the retention window: how often it fired, false positives from reviewers, median latency. */
  async stats(tenantId: string, set: RuleSetRow, rules: Rule[]) {
    const rows = (await this.db('guard_decisions').where({ tenant_id: tenantId }).andWhere('created_at', '>=', Date.now() - RETENTION_DAYS * 86_400_000).whereIn('checkpoint', [...new Set(rules.map((r) => r.checkpoint))]).orderBy('created_at', 'desc').limit(5000).select('checkpoint', 'findings', 'timings')) as { checkpoint: string; findings: string | null; timings: string | null }[];
    const out: Record<string, { evaluated: number; triggered: number; triggerRate: number | null; latencyMs: number | null; falsePositives: { confirmed: number; dismissed: number; rate: number | null } }> = {};
    for (const rule of rules) {
      const key = `${set.id}/${rule.id}`;
      let evaluated = 0;
      let triggered = 0;
      const lat: number[] = [];
      for (const r of rows) {
        if (r.checkpoint !== rule.checkpoint) continue;
        const t = json<Record<string, number>>(r.timings, {});
        if (t[key] === undefined) continue;
        evaluated++;
        lat.push(t[key]);
        if (json<Recorded[]>(r.findings, []).some((f) => f.setId === set.id && f.ruleId === rule.id && !f.error)) triggered++;
      }
      lat.sort((a, b) => a - b);
      out[rule.id] = { evaluated, triggered, triggerRate: evaluated ? triggered / evaluated : null, latencyMs: lat.length ? lat[Math.floor(lat.length / 2)]! : null, falsePositives: await this.flags.falsePositives(tenantId, set.id, rule.id) };
    }
    return out;
  }

  // ---------- shadow replay ----------

  /**
   * Runs a version's rules (all of them, as if enforced) over the inputs recorded at their checkpoints in the
   * retention window, and compares with what the published rules did then. Nothing is changed or flagged.
   */
  private async replayJob(tenantId: string, setId: string, version: number, ctx: JobContext): Promise<unknown> {
    const set = await this.sets.get(tenantId, setId);
    const v = await this.sets.version(set.id, version);
    if (!v) throw new Error(`Version ${version} of ${set.name} does not exist`);
    const rules = v.rules.filter((r) => r.enabled);
    const from = Date.now() - RETENTION_DAYS * 86_400_000;
    const q = this.db('guard_decisions').where({ tenant_id: tenantId }).andWhere('created_at', '>=', from).whereIn('checkpoint', [...new Set(rules.map((r) => r.checkpoint))]);
    if (set.scope === 'workspace') q.andWhere({ workspace_id: set.workspace_id });
    const rows = (await q.orderBy('created_at', 'desc').limit(5000).select('id', 'checkpoint', 'label', 'text', 'meta', 'findings', 'user_id')) as { id: string; checkpoint: string; label: Label; text: string | null; meta: string | null; findings: string | null; user_id: string | null }[];
    const per = new Map(rules.map((r) => [r.id, { id: r.id, name: r.name, checkpoint: r.checkpoint, action: r.action, stage: r.stage, wouldTrigger: 0, publishedTriggered: 0, errors: 0 }]));
    const clearances = new Map<string, Label>();
    for (const [i, row] of rows.entries()) {
      if (ctx.signal.aborted) throw new Error('cancelled');
      const text = row.text ? await this.keys.open(tenantId, row.text, `guard:${row.id}`) : '';
      const recorded = json<Recorded[]>(row.findings, []);
      let clearance = row.user_id ? clearances.get(row.user_id) : undefined;
      if (row.user_id && !clearance) {
        const u = (await this.db('users').where({ id: row.user_id }).first('clearance')) as { clearance: string } | undefined;
        clearance = isLabel(u?.clearance) ? u.clearance : 'public';
        clearances.set(row.user_id, clearance);
      }
      for (const rule of rules) {
        if (rule.checkpoint !== row.checkpoint) continue;
        const stat = per.get(rule.id)!;
        const principal = clearance ? ({ clearance } as GuardInput['principal']) : undefined;
        const r = await this.evaluate(rule, { tenantId, checkpoint: rule.checkpoint, text, label: row.label, meta: json<Record<string, unknown>>(row.meta, {}), ...(principal ? { principal } : {}) });
        if (r.error) stat.errors++;
        else if (r.hit) stat.wouldTrigger++;
        if (recorded.some((f) => f.setId === set.id && f.ruleId === rule.id && !f.pending && !f.error)) stat.publishedTriggered++;
      }
      if ((i + 1) % 50 === 0 || i === rows.length - 1) await ctx.progress(((i + 1) / rows.length) * 100, `${i + 1} of ${rows.length} recorded turns replayed`);
    }
    return { setId: set.id, version, days: RETENTION_DAYS, from, turns: rows.length, rules: [...per.values()] };
  }
}

const publicFinding = (f: Recorded): GuardFinding => ({ ruleId: f.ruleId, ruleName: f.ruleName, action: f.action, stage: f.stage, ...(f.span ? { span: f.span } : {}), ...(f.score != null ? { score: f.score } : {}), ...(f.setId ? { setId: f.setId } : {}), ...(f.detail ? { detail: f.detail } : {}) });

/** Replaces redacted spans; a redacting rule that matched no span redacts the whole text. */
export function redact(text: string, findings: GuardFinding[]): string {
  if (findings.some((f) => !f.span)) return '[redacted]';
  const spans = findings.map((f) => f.span!).sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else merged.push([s[0], s[1]]);
  }
  let out = '';
  let pos = 0;
  for (const [s, e] of merged) {
    out += `${text.slice(pos, s)}[redacted]`;
    pos = e;
  }
  return out + text.slice(pos);
}

/** Only scalar checkpoint facts are kept with a recorded decision (they feed label, budget and meta rules on replay). */
function scalarMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (k === 'prompt') continue;
    if (typeof v === 'string') out[k] = v.slice(0, 200);
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (Array.isArray(v)) out[k] = v.filter((x) => typeof x === 'string').slice(0, 20);
  }
  return out;
}
