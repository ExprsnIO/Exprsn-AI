import { randomInt } from 'node:crypto';
import { ulid } from 'ulid';
import { json } from '../db/knex.js';
import { isUniqueViolation } from '../audit/chain.js';
import { conflict, forbidden, HttpProblem, notFound } from '../http/problem.js';
import type { Services } from '../services.js';
import type { DiscountKind, DiscountScope, DiscountSource, DiscountTarget, DiscountTerms } from './types.js';

/*
 * 1.9.0, Sprint 51 (B-165): discount rules, promotion codes, negotiated discounts, and their dual control. The
 * statement engine (`engine.ts` `applyDiscounts`) applies the rules `applicable` returns; this file keeps them.
 *
 * - A rule above the approval threshold (a percentage above `approvalPercentPpm`, an amount above
 *   `approvalAmountMinor`, and every free allowance, whose value depends on usage) is `proposed` until a second
 *   holder of `billing:manage` approves it; the proposer cannot. A change that would take an active rule above the
 *   threshold waits as a proposal too, and the rule keeps its terms until it is approved.
 * - A promotion rule applies to the tenants that redeemed one of its codes; a code has an expiry and a redemption
 *   limit, counted in one conditional update so concurrent redemptions never pass it.
 * - A negotiated rule targets one tenant.
 */

export interface DiscountRule {
  id: string;
  name: string;
  source: DiscountSource;
  scope: DiscountScope;
  scopeValue: string | null;
  kind: DiscountKind;
  terms: DiscountTerms;
  currency: string | null;
  validFrom: number | null;
  validTo: number | null;
  target: DiscountTarget;
  stackOrder: number;
  state: 'proposed' | 'active' | 'rejected' | 'retired';
  proposedBy: string | null;
  proposedAt: number;
  decidedBy: string | null;
  decidedAt: number | null;
  note: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface DiscountPolicy {
  capPercentPpm: number | null;
  capAmountMinor: number | null;
  approvalPercentPpm: number | null;
  approvalAmountMinor: number | null;
  updatedBy: string | null;
  updatedAt: number | null;
}

/** Until a platform admin sets the policy: no cap; a second admin for more than 20% or more than 500.00 off. */
export const DEFAULT_POLICY: DiscountPolicy = { capPercentPpm: null, capAmountMinor: null, approvalPercentPpm: 200_000, approvalAmountMinor: 50_000, updatedBy: null, updatedAt: null };

export interface PromoCode {
  id: string;
  code: string;
  ruleId: string;
  expiresAt: number | null;
  maxRedemptions: number | null;
  redemptions: number;
  state: 'active' | 'retired';
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface DiscountApproval {
  id: string;
  ruleId: string;
  change: 'create' | 'update';
  proposal: Partial<RuleInput>;
  reason: string | null;
  state: 'pending' | 'approved' | 'rejected';
  proposedBy: string;
  proposedAt: number;
  decidedBy: string | null;
  decidedAt: number | null;
  note: string | null;
}

/** What a rule is made of (the routes validate it with zod). */
export interface RuleInput {
  name: string;
  source: DiscountSource;
  scope: DiscountScope;
  scopeValue: string | null;
  kind: DiscountKind;
  terms: DiscountTerms;
  currency: string | null;
  validFrom: number | null;
  validTo: number | null;
  target: DiscountTarget;
  stackOrder: number;
  note: string | null;
}

/** The fields whose change is a change of terms (and may need a second admin). */
const TERMS_FIELDS = ['scope', 'scopeValue', 'kind', 'terms', 'currency', 'validFrom', 'validTo', 'target'] as const;

const ruleFromRow = (r: Record<string, unknown>): DiscountRule => {
  const kind = String(r.target_kind) as DiscountTarget['kind'];
  const ids = json<string[]>(r.target_ids, []);
  return {
    id: String(r.id),
    name: String(r.name),
    source: r.source as DiscountSource,
    scope: r.scope as DiscountScope,
    scopeValue: (r.scope_value as string | null) ?? null,
    kind: r.kind as DiscountKind,
    terms: json<DiscountTerms>(r.terms, {}),
    currency: (r.currency as string | null) ?? null,
    validFrom: r.valid_from == null ? null : Number(r.valid_from),
    validTo: r.valid_to == null ? null : Number(r.valid_to),
    target: kind === 'all' ? { kind } : { kind, ids },
    stackOrder: Number(r.stack_order),
    state: r.state as DiscountRule['state'],
    proposedBy: (r.proposed_by as string | null) ?? null,
    proposedAt: Number(r.proposed_at),
    decidedBy: (r.decided_by as string | null) ?? null,
    decidedAt: r.decided_at == null ? null : Number(r.decided_at),
    note: (r.note as string | null) ?? null,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at)
  };
};

const ruleColumns = (x: Partial<RuleInput>): Record<string, unknown> => ({
  ...(x.name !== undefined ? { name: x.name } : {}),
  ...(x.source !== undefined ? { source: x.source } : {}),
  ...(x.scope !== undefined ? { scope: x.scope } : {}),
  ...(x.scopeValue !== undefined ? { scope_value: x.scopeValue } : {}),
  ...(x.kind !== undefined ? { kind: x.kind } : {}),
  ...(x.terms !== undefined ? { terms: JSON.stringify(x.terms) } : {}),
  ...(x.currency !== undefined ? { currency: x.currency ? x.currency.toUpperCase() : null } : {}),
  ...(x.validFrom !== undefined ? { valid_from: x.validFrom } : {}),
  ...(x.validTo !== undefined ? { valid_to: x.validTo } : {}),
  ...(x.target !== undefined ? { target_kind: x.target.kind, target_ids: x.target.kind === 'all' ? null : JSON.stringify(x.target.ids) } : {}),
  ...(x.stackOrder !== undefined ? { stack_order: x.stackOrder } : {}),
  ...(x.note !== undefined ? { note: x.note } : {})
});

const codeFromRow = (r: Record<string, unknown>): PromoCode => ({
  id: String(r.id),
  code: String(r.code),
  ruleId: String(r.rule_id),
  expiresAt: r.expires_at == null ? null : Number(r.expires_at),
  maxRedemptions: r.max_redemptions == null ? null : Number(r.max_redemptions),
  redemptions: Number(r.redemptions ?? 0),
  state: r.state as PromoCode['state'],
  createdBy: (r.created_by as string | null) ?? null,
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at)
});

const approvalFromRow = (r: Record<string, unknown>): DiscountApproval => ({
  id: String(r.id),
  ruleId: String(r.rule_id),
  change: r.change as DiscountApproval['change'],
  proposal: json<Partial<RuleInput>>(r.proposal, {}),
  reason: (r.reason as string | null) ?? null,
  state: r.state as DiscountApproval['state'],
  proposedBy: String(r.proposed_by),
  proposedAt: Number(r.proposed_at),
  decidedBy: (r.decided_by as string | null) ?? null,
  decidedAt: r.decided_at == null ? null : Number(r.decided_at),
  note: (r.note as string | null) ?? null
});

/** Why a rule needs a second admin under a policy, or null when it does not. */
export function approvalReason(r: Pick<RuleInput, 'kind' | 'terms'>, policy: Pick<DiscountPolicy, 'approvalPercentPpm' | 'approvalAmountMinor'>): string | null {
  const pct = r.kind === 'percent' || r.kind === 'commitment' ? (r.terms.percentPpm ?? 0) : r.kind === 'volume' ? Math.max(0, ...(r.terms.tiers ?? []).map((t) => t.percentPpm)) : null;
  if (pct != null && policy.approvalPercentPpm != null && pct > policy.approvalPercentPpm) return `${pct / 10_000}% is above the ${policy.approvalPercentPpm / 10_000}% approval threshold`;
  if (r.kind === 'amount' && policy.approvalAmountMinor != null && (r.terms.amountMinor ?? 0) > policy.approvalAmountMinor) return `${r.terms.amountMinor} is above the approval threshold of ${policy.approvalAmountMinor} (minor units)`;
  if (r.kind === 'allowance') return 'a free allowance is valued by usage, so a second admin approves it';
  return null;
}

/** Checks a rule's terms fit its kind and scope; throws a 400 problem otherwise. */
export function checkRule(r: Pick<RuleInput, 'scope' | 'scopeValue' | 'kind' | 'terms' | 'currency' | 'validFrom' | 'validTo' | 'source' | 'target'>): void {
  const bad = (detail: string) => new HttpProblem(400, 'Invalid request', detail);
  if ((r.scope === 'meter' || r.scope === 'model' || r.scope === 'family') !== !!r.scopeValue) throw bad('A meter, model or family scope names it in scopeValue; other scopes do not.');
  if ((r.kind === 'percent' || r.kind === 'commitment') && !(r.terms.percentPpm != null && r.terms.percentPpm > 0)) throw bad(`A ${r.kind} discount needs terms.percentPpm.`);
  if (r.kind === 'amount' && !(r.terms.amountMinor != null && r.terms.amountMinor > 0 && r.currency)) throw bad('A fixed amount needs terms.amountMinor and a currency.');
  if (r.kind === 'allowance') {
    if (!(r.terms.quantity != null && r.terms.quantity > 0)) throw bad('A free allowance needs terms.quantity.');
    const meter = r.scope === 'meter' ? r.scopeValue : r.terms.meter;
    if (!meter || !(r.scope === 'meter' || r.scope === 'model' || r.scope === 'family')) throw bad('A free allowance is of a meter: scope meter, or model or family with terms.meter.');
  }
  if (r.kind === 'volume') {
    const tiers = r.terms.tiers ?? [];
    if (!tiers.length) throw bad('A volume discount needs terms.tiers.');
    for (let i = 1; i < tiers.length; i++) if (!(tiers[i]!.from > tiers[i - 1]!.from)) throw bad('Volume tiers go up: each from above the last.');
    const measure = r.terms.measure ?? 'amount';
    if (measure === 'quantity' && !(r.scope === 'meter' || ((r.scope === 'model' || r.scope === 'family') && r.terms.meter))) throw bad('A volume discount by quantity is on a meter (scope meter, or model or family with terms.meter).');
  }
  if (r.validFrom != null && r.validTo != null && r.validTo <= r.validFrom) throw bad('validTo is after validFrom.');
  if (r.source === 'negotiated' && !(r.target.kind === 'tenants' && r.target.ids.length === 1)) throw bad('A negotiated discount is for one tenant (target tenants with one id).');
}

const familyOf = (model: string): string => model.split(':')[0]!;

/** Whether a model is in a scope's model or family (`llama3.1` covers `llama3.1:8b`; a trailing `*` is a prefix). */
export function modelInScope(scope: DiscountScope, value: string | null, model: string | null): boolean {
  if (!model || !value) return false;
  if (scope === 'model') return model === value;
  if (scope === 'family') return value.endsWith('*') ? model.startsWith(value.slice(0, -1)) : familyOf(model) === value || model === value;
  return false;
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const normaliseCode = (code: string): string => code.trim().toUpperCase();

export class DiscountService {
  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  // ---------- policy ----------

  async policy(): Promise<DiscountPolicy> {
    const r = await this.db('billing_discount_policy').where({ id: 'platform' }).first();
    if (!r) return { ...DEFAULT_POLICY };
    const n = (v: unknown) => (v == null ? null : Number(v));
    return { capPercentPpm: n(r.cap_percent_ppm), capAmountMinor: n(r.cap_amount_minor), approvalPercentPpm: n(r.approval_percent_ppm), approvalAmountMinor: n(r.approval_amount_minor), updatedBy: (r.updated_by as string | null) ?? null, updatedAt: n(r.updated_at) };
  }

  async setPolicy(by: string, patch: Partial<Pick<DiscountPolicy, 'capPercentPpm' | 'capAmountMinor' | 'approvalPercentPpm' | 'approvalAmountMinor'>>): Promise<{ before: DiscountPolicy; after: DiscountPolicy }> {
    const before = await this.policy();
    const next = { ...before, ...patch };
    const row = { cap_percent_ppm: next.capPercentPpm, cap_amount_minor: next.capAmountMinor, approval_percent_ppm: next.approvalPercentPpm, approval_amount_minor: next.approvalAmountMinor, updated_by: by, updated_at: Date.now() };
    const n = await this.db('billing_discount_policy').where({ id: 'platform' }).update(row);
    if (!n) {
      try {
        await this.db('billing_discount_policy').insert({ id: 'platform', ...row });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        await this.db('billing_discount_policy').where({ id: 'platform' }).update(row);
      }
    }
    return { before, after: await this.policy() };
  }

  // ---------- rules ----------

  async rules(filter: { state?: DiscountRule['state']; source?: DiscountSource; tenantId?: string } = {}): Promise<DiscountRule[]> {
    const q = this.db('billing_discount_rules').orderBy('stack_order', 'asc').orderBy('created_at', 'asc').orderBy('id', 'asc');
    if (filter.state) q.where({ state: filter.state });
    if (filter.source) q.where({ source: filter.source });
    const rows = ((await q) as Record<string, unknown>[]).map(ruleFromRow);
    return filter.tenantId ? rows.filter((r) => r.target.kind === 'tenants' && r.target.ids.includes(filter.tenantId!)) : rows;
  }

  async rule(id: string): Promise<DiscountRule> {
    const r = await this.db('billing_discount_rules').where({ id }).first();
    if (!r) throw notFound('Discount rule');
    return ruleFromRow(r);
  }

  /** Creates a rule: active at once, or proposed for a second admin when it is above the threshold. */
  async create(by: string, input: RuleInput): Promise<{ rule: DiscountRule; approval: DiscountApproval | null; reason: string | null }> {
    checkRule(input);
    const reason = approvalReason(input, await this.policy());
    const id = ulid();
    const t = Date.now();
    const approvalId = reason ? ulid() : null;
    await this.db.transaction(async (trx) => {
      await trx('billing_discount_rules').insert({ id, ...ruleColumns(input), state: reason ? 'proposed' : 'active', proposed_by: by, proposed_at: t, decided_by: reason ? null : by, decided_at: reason ? null : t, updated_by: by, created_at: t, updated_at: t });
      if (approvalId) await trx('billing_discount_approvals').insert({ id: approvalId, rule_id: id, change: 'create', proposal: JSON.stringify(input), reason, state: 'pending', proposed_by: by, proposed_at: t });
    });
    return { rule: await this.rule(id), approval: approvalId ? await this.approval(approvalId) : null, reason };
  }

  /**
   * Changes a rule. Its name, stacking order and note change at once, and so does retiring it; a change of terms
   * that leaves it at or below the threshold applies at once too, and one above it waits for a second admin.
   */
  async update(by: string, id: string, patch: Partial<RuleInput> & { state?: 'retired' }): Promise<{ before: DiscountRule; rule: DiscountRule; approval: DiscountApproval | null; reason: string | null }> {
    const before = await this.rule(id);
    if (before.state === 'rejected' || before.state === 'retired') throw conflict(`The rule is ${before.state}; make a new one.`);
    const termsChanged = TERMS_FIELDS.some((k) => patch[k] !== undefined && JSON.stringify(patch[k]) !== JSON.stringify(before[k]));
    const merged: RuleInput = { name: patch.name ?? before.name, source: before.source, scope: patch.scope ?? before.scope, scopeValue: patch.scopeValue !== undefined ? patch.scopeValue : before.scopeValue, kind: patch.kind ?? before.kind, terms: patch.terms ?? before.terms, currency: patch.currency !== undefined ? patch.currency : before.currency, validFrom: patch.validFrom !== undefined ? patch.validFrom : before.validFrom, validTo: patch.validTo !== undefined ? patch.validTo : before.validTo, target: patch.target ?? before.target, stackOrder: patch.stackOrder ?? before.stackOrder, note: patch.note !== undefined ? patch.note : before.note };
    checkRule(merged);
    const reason = termsChanged ? approvalReason(merged, await this.policy()) : null;
    const t = Date.now();
    const direct: Partial<RuleInput> = { ...(patch.name !== undefined ? { name: patch.name } : {}), ...(patch.stackOrder !== undefined ? { stackOrder: patch.stackOrder } : {}), ...(patch.note !== undefined ? { note: patch.note } : {}) };
    const terms: Partial<RuleInput> = Object.fromEntries(TERMS_FIELDS.filter((k) => patch[k] !== undefined).map((k) => [k, patch[k]]));
    let approvalId: string | null = null;
    await this.db.transaction(async (trx) => {
      const upd: Record<string, unknown> = { ...ruleColumns(direct), updated_by: by, updated_at: t };
      if (patch.state === 'retired') upd.state = 'retired';
      if (termsChanged && !reason) Object.assign(upd, ruleColumns(terms));
      // A proposed rule's own proposal follows the change, so the approver sees what will apply.
      if (termsChanged && before.state === 'proposed') {
        Object.assign(upd, ruleColumns(terms));
        await trx('billing_discount_approvals').where({ rule_id: id, change: 'create', state: 'pending' }).update({ proposal: JSON.stringify(merged), reason: reason ?? 'proposed before the change' });
      } else if (termsChanged && reason) {
        approvalId = ulid();
        await trx('billing_discount_approvals').where({ rule_id: id, change: 'update', state: 'pending' }).update({ state: 'rejected', decided_by: by, decided_at: t, note: 'replaced by a newer proposal' });
        await trx('billing_discount_approvals').insert({ id: approvalId, rule_id: id, change: 'update', proposal: JSON.stringify(terms), reason, state: 'pending', proposed_by: by, proposed_at: t });
      }
      await trx('billing_discount_rules').where({ id }).update(upd);
      if (patch.state === 'retired') await trx('billing_discount_approvals').where({ rule_id: id, state: 'pending' }).update({ state: 'rejected', decided_by: by, decided_at: t, note: 'the rule was retired' });
    });
    return { before, rule: await this.rule(id), approval: approvalId ? await this.approval(approvalId) : null, reason };
  }

  // ---------- approvals (dual control) ----------

  async approvals(state?: DiscountApproval['state']): Promise<DiscountApproval[]> {
    const q = this.db('billing_discount_approvals').orderBy('proposed_at', 'desc').limit(200);
    if (state) q.where({ state });
    return ((await q) as Record<string, unknown>[]).map(approvalFromRow);
  }

  async approval(id: string): Promise<DiscountApproval> {
    const r = await this.db('billing_discount_approvals').where({ id }).first();
    if (!r) throw notFound('Discount approval');
    return approvalFromRow(r);
  }

  /** A second admin approves or rejects a proposal. The proposer cannot decide it. */
  async decide(by: string, id: string, decision: 'approve' | 'reject', note: string | null): Promise<{ approval: DiscountApproval; rule: DiscountRule }> {
    const a = await this.approval(id);
    if (a.state !== 'pending') throw conflict(`The proposal is already ${a.state}.`);
    if (a.proposedBy === by) throw forbidden('Dual control: someone other than the proposer must decide.', { step: 'dual-control' });
    const t = Date.now();
    await this.db.transaction(async (trx) => {
      const n = await trx('billing_discount_approvals').where({ id, state: 'pending' }).update({ state: decision === 'approve' ? 'approved' : 'rejected', decided_by: by, decided_at: t, note });
      if (!n) throw conflict('The proposal was decided meanwhile.');
      if (a.change === 'create') await trx('billing_discount_rules').where({ id: a.ruleId, state: 'proposed' }).update({ state: decision === 'approve' ? 'active' : 'rejected', decided_by: by, decided_at: t, updated_at: t });
      else if (decision === 'approve') await trx('billing_discount_rules').where({ id: a.ruleId }).whereIn('state', ['active']).update({ ...ruleColumns(a.proposal), decided_by: by, decided_at: t, updated_at: t });
    });
    return { approval: await this.approval(id), rule: await this.rule(a.ruleId) };
  }

  // ---------- promotion codes ----------

  async codes(ruleId?: string): Promise<PromoCode[]> {
    const q = this.db('billing_promo_codes').orderBy('created_at', 'desc');
    if (ruleId) q.where({ rule_id: ruleId });
    return ((await q) as Record<string, unknown>[]).map(codeFromRow);
  }

  async code(id: string): Promise<PromoCode> {
    const r = await this.db('billing_promo_codes').where({ id }).first();
    if (!r) throw notFound('Promotion code');
    return codeFromRow(r);
  }

  async createCode(by: string, input: { code?: string | null; ruleId: string; expiresAt: number | null; maxRedemptions: number | null }): Promise<PromoCode> {
    const rule = await this.rule(input.ruleId);
    if (rule.source !== 'promotion') throw conflict('Codes redeem promotion rules; this rule is not one.');
    if (rule.state === 'rejected' || rule.state === 'retired') throw conflict(`The rule is ${rule.state}.`);
    const code = input.code ? normaliseCode(input.code) : Array.from({ length: 10 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
    const id = ulid();
    const t = Date.now();
    try {
      await this.db('billing_promo_codes').insert({ id, code, rule_id: rule.id, expires_at: input.expiresAt, max_redemptions: input.maxRedemptions, redemptions: 0, state: 'active', created_by: by, created_at: t, updated_at: t });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict(`The code ${code} exists.`);
      throw err;
    }
    return this.code(id);
  }

  async updateCode(id: string, patch: { expiresAt?: number | null; maxRedemptions?: number | null; state?: 'active' | 'retired' }): Promise<{ before: PromoCode; after: PromoCode }> {
    const before = await this.code(id);
    const upd: Record<string, unknown> = { updated_at: Date.now() };
    if (patch.expiresAt !== undefined) upd.expires_at = patch.expiresAt;
    if (patch.maxRedemptions !== undefined) {
      if (patch.maxRedemptions != null && patch.maxRedemptions < before.redemptions) throw conflict(`The code has been redeemed ${before.redemptions} times already.`);
      upd.max_redemptions = patch.maxRedemptions;
    }
    if (patch.state !== undefined) upd.state = patch.state;
    await this.db('billing_promo_codes').where({ id }).update(upd);
    return { before, after: await this.code(id) };
  }

  /**
   * A tenant redeems a code: the code is active and not expired, its rule is active and valid now and targets the
   * tenant (or its plan), and the redemption limit has room. One conditional update counts the redemption, so two
   * tenants redeeming the last place at once cannot both have it; a tenant redeems a code once.
   */
  async redeem(tenantId: string, by: string, codeText: string, planId: string | null, now = Date.now()): Promise<{ code: PromoCode; rule: DiscountRule; redemptionId: string }> {
    const code = normaliseCode(codeText);
    const row = await this.db('billing_promo_codes').where({ code }).first();
    // One answer for every reason a code does not work, so codes cannot be probed.
    const refuse = (why: string) => Object.assign(conflict('This code cannot be redeemed.'), { why });
    if (!row) throw refuse('unknown code');
    const c = codeFromRow(row);
    if (c.state !== 'active') throw refuse('code retired');
    if (c.expiresAt != null && c.expiresAt <= now) throw refuse('code expired');
    const rule = await this.rule(c.ruleId);
    if (rule.state !== 'active') throw refuse(`rule ${rule.state}`);
    // A promotion may be redeemed before it starts (it applies once valid), not after it ends.
    if (rule.validTo != null && rule.validTo <= now) throw refuse('rule no longer valid');
    if (rule.target.kind === 'tenants' && !rule.target.ids.includes(tenantId)) throw refuse('not for this tenant');
    if (rule.target.kind === 'plans' && !(planId && rule.target.ids.includes(planId))) throw refuse('not for this plan');
    const redemptionId = ulid();
    try {
      await this.db.transaction(async (trx) => {
        await trx('billing_promo_redemptions').insert({ id: redemptionId, code_id: c.id, rule_id: rule.id, tenant_id: tenantId, redeemed_by: by, redeemed_at: now });
        const n = await trx('billing_promo_codes')
          .where({ id: c.id, state: 'active' })
          .andWhere((w) => w.whereNull('max_redemptions').orWhere('redemptions', '<', trx.ref('max_redemptions')))
          .update({ redemptions: trx.raw('redemptions + 1'), updated_at: now });
        if (!n) throw refuse('redemption limit reached');
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw refuse('already redeemed by this tenant');
      throw err;
    }
    return { code: await this.code(c.id), rule, redemptionId };
  }

  async redemptions(filter: { tenantId?: string; codeId?: string } = {}): Promise<{ id: string; codeId: string; ruleId: string; tenantId: string; redeemedBy: string | null; redeemedAt: number }[]> {
    const q = this.db('billing_promo_redemptions').orderBy('redeemed_at', 'desc').limit(500);
    if (filter.tenantId) q.where({ tenant_id: filter.tenantId });
    if (filter.codeId) q.where({ code_id: filter.codeId });
    return ((await q) as Record<string, unknown>[]).map((r) => ({ id: String(r.id), codeId: String(r.code_id), ruleId: String(r.rule_id), tenantId: String(r.tenant_id), redeemedBy: (r.redeemed_by as string | null) ?? null, redeemedAt: Number(r.redeemed_at) }));
  }

  // ---------- what applies ----------

  /**
   * The active rules that apply to a tenant's statement for `[from, to)`, in stacking order (ascending
   * `stackOrder`, then oldest first): valid at some moment of the window, targeting the tenant (all, listed, or its
   * plan), and for a promotion, redeemed by the tenant before the window ends.
   */
  async applicable(tenantId: string, planIds: readonly string[], from: number, to: number): Promise<DiscountRule[]> {
    const rows = ((await this.db('billing_discount_rules')
      .where({ state: 'active' })
      .andWhere((w) => w.whereNull('valid_from').orWhere('valid_from', '<', to))
      .andWhere((w) => w.whereNull('valid_to').orWhere('valid_to', '>', from))
      .orderBy('stack_order', 'asc')
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')) as Record<string, unknown>[]).map(ruleFromRow);
    if (!rows.length) return [];
    const promos = rows.some((r) => r.source === 'promotion') ? new Set(((await this.db('billing_promo_redemptions').where({ tenant_id: tenantId }).andWhere('redeemed_at', '<', to).select('rule_id')) as { rule_id: string }[]).map((x) => x.rule_id)) : new Set<string>();
    return rows.filter((r) => {
      if (r.source === 'promotion' && !promos.has(r.id)) return false;
      if (r.target.kind === 'tenants') return r.target.ids.includes(tenantId);
      if (r.target.kind === 'plans') return r.target.ids.some((p) => planIds.includes(p));
      return true;
    });
  }
}

export const ruleView = (r: DiscountRule) => ({ ...r, validFrom: r.validFrom ? new Date(r.validFrom).toISOString() : null, validTo: r.validTo ? new Date(r.validTo).toISOString() : null });
export const codeView = (c: PromoCode) => ({ ...c, expiresAt: c.expiresAt ? new Date(c.expiresAt).toISOString() : null });
