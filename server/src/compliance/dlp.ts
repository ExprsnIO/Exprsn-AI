import { ulid } from 'ulid';
import { z } from 'zod';
import { actorFrom } from '../audit/chain.js';
import { highest, LABELS, labelRank, type Label } from '../authz/labels.js';
import type { Principal } from '../authz/policy.js';
import { json } from '../db/knex.js';
import { detectPii, detectSecrets, PII_KINDS, SECRET_KINDS, type Detection } from '../guardrails/detectors.js';
import { compilePattern } from '../guardrails/regex.js';
import { HttpProblem, notFound } from '../http/problem.js';
import type { Services } from '../services.js';

/*
 * DLP (1.6.0, B-7601): answers, agent outputs and uploads classified by detector, their label raised, and a rule's
 * action by that label.
 *
 * A DLP rule names what it detects (the built-in PII and secret detectors of `guardrails/detectors.ts`, and the
 * tenant's own RE2 patterns, `pattern:<id>`), the label the content rises to when one of them fires, the action
 * (`label`: raise the label only; `redact`: replace the detected spans; `hold`: keep the content for a reviewer) and
 * the scopes it applies to (`answer`: chat and `/v1` answers; `agent`: agent run outputs; `upload`: attachments and
 * files). Every scope's feature calls `inspect` after its guardrail checkpoint and applies the result: the label of
 * the message, run, attachment or file version (and of the conversation) rises to the result's label; a hold goes to
 * the flag queue (an upload is refused with the reason); a redaction is what is stored. Content raised above its
 * owner's clearance is held, whatever the rule says, since the owner may not read it.
 *
 * Nothing here is a guardrail rule: guardrails decide by checkpoint and rule set, with shadow and enforce stages; DLP
 * rules are the tenant's data classification, always in force, kept by `compliance:manage`.
 */

export { DLP_ACTIONS, DLP_SCOPES, noDlp, type DlpAction, type DlpDetection, type DlpInput, type DlpInspector, type DlpResult, type DlpScope } from './dlp-types.js';
import { DLP_ACTIONS, DLP_SCOPES, type DlpAction, type DlpDetection, type DlpInput, type DlpInspector, type DlpResult, type DlpScope } from './dlp-types.js';
const ACTION_RANK: Record<DlpAction, number> = { label: 0, redact: 1, hold: 2 };
export const BUILTIN_DETECTORS: readonly string[] = [...PII_KINDS, ...SECRET_KINDS];

const detectorSchema = z.string().refine((d) => (BUILTIN_DETECTORS as readonly string[]).includes(d) || /^pattern:[0-9A-Z]{26}$/.test(d), 'a built-in detector or pattern:<id>');

export const dlpRuleInputSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    enabled: z.boolean().default(true),
    detectors: z.array(detectorSchema).min(1).max(50),
    raiseTo: z.enum(LABELS),
    action: z.enum(DLP_ACTIONS),
    scopes: z.array(z.enum(DLP_SCOPES)).min(1).max(3)
  })
  .strict();
export type DlpRuleInput = z.infer<typeof dlpRuleInputSchema>;

export const dlpPatternInputSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    pattern: z.string().min(1).max(2000),
    label: z.enum(LABELS),
    enabled: z.boolean().default(true)
  })
  .strict();
export type DlpPatternInput = z.infer<typeof dlpPatternInputSchema>;

export interface DlpRule {
  id: string;
  tenant_id: string;
  name: string;
  enabled: boolean;
  detectors: string[];
  raise_to: Label;
  action: DlpAction;
  scopes: DlpScope[];
  created_by: string | null;
  updated_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface DlpPattern {
  id: string;
  tenant_id: string;
  name: string;
  pattern: string;
  label: Label;
  enabled: boolean;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

const ruleFrom = (r: Record<string, unknown>): DlpRule => ({ ...(r as unknown as DlpRule), enabled: !!r.enabled, detectors: json<string[]>(r.detectors, []), scopes: json<DlpScope[]>(r.scopes, []), created_at: Number(r.created_at), updated_at: Number(r.updated_at) });
const patternFrom = (r: Record<string, unknown>): DlpPattern => ({ ...(r as unknown as DlpPattern), enabled: !!r.enabled, created_at: Number(r.created_at), updated_at: Number(r.updated_at) });

export const ruleView = (r: DlpRule) => ({ id: r.id, name: r.name, enabled: r.enabled, detectors: r.detectors, raiseTo: r.raise_to, action: r.action, scopes: r.scopes, createdAt: r.created_at, updatedAt: r.updated_at });
export const patternView = (p: DlpPattern) => ({ id: p.id, name: p.name, pattern: p.pattern, label: p.label, enabled: p.enabled, createdAt: p.created_at, updatedAt: p.updated_at });

/** Replaces spans (merged, so overlapping detections become one) with a marker naming the kind. */
export function redactSpans(text: string, spans: { span: [number, number]; kind: string }[]): string {
  const sorted = [...spans].sort((a, b) => a.span[0] - b.span[0] || b.span[1] - a.span[1]);
  let out = '';
  let at = 0;
  for (const s of sorted) {
    const [a, b] = s.span;
    if (b <= at) continue;
    const start = Math.max(a, at);
    out += text.slice(at, start) + (start === a ? `[redacted ${s.kind.replace(/_/g, ' ')}]` : '');
    at = b;
  }
  return out + text.slice(at);
}

export class DlpService implements DlpInspector {
  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  // ---------- rules and patterns (compliance:manage) ----------

  async rules(tenantId: string): Promise<DlpRule[]> {
    return ((await this.db('dlp_rules').where({ tenant_id: tenantId }).orderBy('created_at')) as Record<string, unknown>[]).map(ruleFrom);
  }

  async patterns(tenantId: string): Promise<DlpPattern[]> {
    return ((await this.db('dlp_patterns').where({ tenant_id: tenantId }).orderBy('created_at')) as Record<string, unknown>[]).map(patternFrom);
  }

  private audit(p: Principal, ip: string | null, action: string, target: Record<string, unknown>, detail?: Record<string, unknown>) {
    return this.s().audit.append({ tenantId: p.tenantId, action, kind: 'admin', actor: actorFrom(p, ip), target, ...(detail ? { detail } : {}) });
  }

  private async checkDetectors(tenantId: string, detectors: string[]): Promise<void> {
    const ids = detectors.filter((d) => d.startsWith('pattern:')).map((d) => d.slice('pattern:'.length));
    if (!ids.length) return;
    const found = (await this.db('dlp_patterns').where({ tenant_id: tenantId }).whereIn('id', ids).select('id')) as { id: string }[];
    const missing = ids.filter((id) => !found.some((f) => f.id === id));
    if (missing.length) throw new HttpProblem(422, 'Unknown pattern', `No pattern of this tenant has the id ${missing.join(', ')}.`, { extensions: { detectors: missing.map((m) => `pattern:${m}`) } });
  }

  async createRule(p: Principal, ip: string | null, input: DlpRuleInput): Promise<DlpRule> {
    await this.checkDetectors(p.tenantId, input.detectors);
    const t = Date.now();
    const id = ulid();
    await this.db('dlp_rules').insert({ id, tenant_id: p.tenantId, name: input.name, enabled: input.enabled, detectors: JSON.stringify(input.detectors), raise_to: input.raiseTo, action: input.action, scopes: JSON.stringify(input.scopes), created_by: p.userId, updated_by: p.userId, created_at: t, updated_at: t });
    await this.audit(p, ip, 'dlp.rule.created', { rule: id }, { name: input.name, detectors: input.detectors, raiseTo: input.raiseTo, action: input.action, scopes: input.scopes });
    return (await this.rule(p.tenantId, id))!;
  }

  async rule(tenantId: string, id: string): Promise<DlpRule | undefined> {
    const r = await this.db('dlp_rules').where({ tenant_id: tenantId, id }).first();
    return r ? ruleFrom(r) : undefined;
  }

  async updateRule(p: Principal, ip: string | null, id: string, input: DlpRuleInput): Promise<DlpRule> {
    if (!(await this.rule(p.tenantId, id))) throw notFound('DLP rule');
    await this.checkDetectors(p.tenantId, input.detectors);
    await this.db('dlp_rules').where({ id }).update({ name: input.name, enabled: input.enabled, detectors: JSON.stringify(input.detectors), raise_to: input.raiseTo, action: input.action, scopes: JSON.stringify(input.scopes), updated_by: p.userId, updated_at: Date.now() });
    await this.audit(p, ip, 'dlp.rule.updated', { rule: id }, { name: input.name, enabled: input.enabled, detectors: input.detectors, raiseTo: input.raiseTo, action: input.action, scopes: input.scopes });
    return (await this.rule(p.tenantId, id))!;
  }

  async removeRule(p: Principal, ip: string | null, id: string): Promise<void> {
    const r = await this.rule(p.tenantId, id);
    if (!r) throw notFound('DLP rule');
    await this.db('dlp_rules').where({ id }).delete();
    await this.audit(p, ip, 'dlp.rule.deleted', { rule: id }, { name: r.name });
  }

  async createPattern(p: Principal, ip: string | null, input: DlpPatternInput): Promise<DlpPattern> {
    const c = compilePattern(input.pattern);
    if (!c.ok) throw new HttpProblem(422, 'Invalid pattern', `RE2 rejected the pattern at position ${c.error.pos}: ${c.error.msg}.`, { extensions: { pattern: input.pattern, error: c.error } });
    const t = Date.now();
    const id = ulid();
    await this.db('dlp_patterns').insert({ id, tenant_id: p.tenantId, name: input.name, pattern: input.pattern, label: input.label, enabled: input.enabled, created_by: p.userId, created_at: t, updated_at: t });
    await this.audit(p, ip, 'dlp.pattern.created', { pattern: id }, { name: input.name, label: input.label });
    return patternFrom((await this.db('dlp_patterns').where({ id }).first())!);
  }

  async updatePattern(p: Principal, ip: string | null, id: string, input: DlpPatternInput): Promise<DlpPattern> {
    const existing = await this.db('dlp_patterns').where({ tenant_id: p.tenantId, id }).first();
    if (!existing) throw notFound('DLP pattern');
    const c = compilePattern(input.pattern);
    if (!c.ok) throw new HttpProblem(422, 'Invalid pattern', `RE2 rejected the pattern at position ${c.error.pos}: ${c.error.msg}.`, { extensions: { pattern: input.pattern, error: c.error } });
    await this.db('dlp_patterns').where({ id }).update({ name: input.name, pattern: input.pattern, label: input.label, enabled: input.enabled, updated_at: Date.now() });
    await this.audit(p, ip, 'dlp.pattern.updated', { pattern: id }, { name: input.name, label: input.label, enabled: input.enabled });
    return patternFrom((await this.db('dlp_patterns').where({ id }).first())!);
  }

  async removePattern(p: Principal, ip: string | null, id: string): Promise<void> {
    const existing = await this.db('dlp_patterns').where({ tenant_id: p.tenantId, id }).first();
    if (!existing) throw notFound('DLP pattern');
    const used = (await this.db('dlp_rules').where({ tenant_id: p.tenantId }).andWhere('detectors', 'like', `%pattern:${id}%`).select('name')) as { name: string }[];
    if (used.length) throw new HttpProblem(409, 'Pattern in use', `The rule ${used.map((u) => u.name).join(', ')} detects with this pattern. Change the rule first.`, { extensions: { rules: used.map((u) => u.name) } });
    await this.db('dlp_patterns').where({ id }).delete();
    await this.audit(p, ip, 'dlp.pattern.deleted', { pattern: id }, { name: String(existing.name) });
  }

  // ---------- inspection ----------

  /** Detections of one detector over the text: a built-in kind, or one of the tenant's patterns. */
  private detect(detector: string, text: string, patterns: Map<string, DlpPattern>): Detection[] {
    if ((PII_KINDS as readonly string[]).includes(detector)) return detectPii(text, [detector]);
    if ((SECRET_KINDS as readonly string[]).includes(detector)) return detectSecrets(text, [detector]);
    const pat = detector.startsWith('pattern:') ? patterns.get(detector.slice('pattern:'.length)) : undefined;
    if (!pat || !pat.enabled) return [];
    const c = compilePattern(pat.pattern);
    if (!c.ok) return [];
    const out: Detection[] = [];
    c.re.lastIndex = 0;
    for (let m = c.re.exec(text); m && out.length < 5000; m = c.re.exec(text)) {
      if (!m[0]) {
        c.re.lastIndex++;
        continue;
      }
      out.push({ kind: `pattern:${pat.name}`, span: [m.index, m.index + m[0].length], score: 1 });
    }
    return out;
  }

  async inspect(input: DlpInput): Promise<DlpResult> {
    const none: DlpResult = { label: input.label, raised: false, action: null, text: input.text, detections: [], rules: [] };
    const rules = (await this.rules(input.tenantId)).filter((r) => r.enabled && r.scopes.includes(input.scope));
    if (!rules.length || !input.text) return none;
    const max = this.s().cfg.DLP_MAX_TEXT_BYTES;
    const text = input.text.length > max ? input.text.slice(0, max) : input.text;
    const patterns = new Map((await this.patterns(input.tenantId)).map((p) => [p.id, p]));
    const detections: DlpDetection[] = [];
    const fired: DlpResult['rules'] = [];
    let label = input.label;
    let action: DlpAction | null = null;
    for (const r of rules) {
      const kinds = new Set<string>();
      for (const d of r.detectors) {
        for (const hit of this.detect(d, text, patterns)) {
          if (hit.score < 0.8) continue;
          detections.push({ ...hit, rule: r.id });
          kinds.add(hit.kind);
        }
      }
      if (!kinds.size) continue;
      // A tenant pattern's own label counts too, so a rule that raises to internal still classifies a restricted pattern.
      const patternLabels = r.detectors.filter((d) => d.startsWith('pattern:')).map((d) => patterns.get(d.slice('pattern:'.length))).filter((p): p is DlpPattern => !!p && kinds.has(`pattern:${p.name}`)).map((p) => p.label);
      label = highest(label, r.raise_to, ...patternLabels);
      if (!action || ACTION_RANK[r.action] > ACTION_RANK[action]) action = r.action;
      fired.push({ id: r.id, name: r.name, action: r.action, raiseTo: r.raise_to, kinds: [...kinds] });
    }
    if (!fired.length) return none;
    const redacted = action === 'redact' ? redactSpans(text, detections) + (text.length < input.text.length ? input.text.slice(text.length) : '') : input.text;
    return { label, raised: labelRank(label) > labelRank(input.label), action, text: redacted, detections, rules: fired };
  }
}
