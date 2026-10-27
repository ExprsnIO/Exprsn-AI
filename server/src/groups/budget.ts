import { ulid } from 'ulid';
import { actorFrom, isUniqueViolation } from '../audit/chain.js';
import { conflict, HttpProblem } from '../http/problem.js';
import type { Services } from '../services.js';
import type { Ctx } from './service.js';

/*
 * 1.9.0, Sprint 53 (B-174, B-176): a group's budget, the smallest that lets a proposal spend from it.
 *
 * A budget is an amount in minor units (cents) of one currency (ISO 4217, three letters) and a ledger: every change is
 * an entry with its signed amount, the balance after it, a memo (sealed as `group-budget-entry:<id>`) and who made it.
 * Nothing leaves the server: there is no payment provider behind it; a spend records that the group decided to pay,
 * and what is left. Holders of the group's `settings` right (its owners and admins) set the currency while the
 * balance is zero and record money in or out; a passed proposal of kind `spend` records its spend as the group (one
 * entry per proposal, unique, so it is never spent twice). The balance never goes below zero.
 */

export const BUDGET_LIMITS = { memo: 500, amountMinor: 1_000_000_000_000 } as const;

export interface BudgetRow {
  group_id: string;
  tenant_id: string;
  currency: string;
  balance_minor: number;
  updated_at: number;
}

export class GroupBudget {
  constructor(private readonly s: () => Services) {}

  private get db() {
    return this.s().db;
  }

  async row(groupId: string): Promise<BudgetRow | null> {
    const r = (await this.db('group_budgets').where({ group_id: groupId }).first()) as Record<string, unknown> | undefined;
    return r ? { ...(r as unknown as BudgetRow), balance_minor: Number(r.balance_minor), updated_at: Number(r.updated_at) } : null;
  }

  /** The budget and its last entries, for whoever reads the group. */
  async view(tenantId: string, groupId: string, limit = 50) {
    const b = await this.row(groupId);
    const rows = (await this.db('group_budget_entries').where({ tenant_id: tenantId, group_id: groupId }).orderBy('created_at', 'desc').orderBy('id', 'desc').limit(limit)) as Record<string, unknown>[];
    const names = await this.names(tenantId, rows.map((r) => String(r.created_by)));
    const entries = [];
    for (const r of rows) {
      const memo = r.memo ? ((await this.s().keys.open(tenantId, String(r.memo), `group-budget-entry:${String(r.id)}`)) ?? null) : null;
      entries.push({ id: String(r.id), amountMinor: Number(r.amount_minor), currency: String(r.currency), balanceAfter: Number(r.balance_after), memo, proposalId: (r.proposal_id as string | null) ?? null, createdBy: String(r.created_by), createdByName: names.get(String(r.created_by)) ?? (r.proposal_id ? 'By decision' : null), createdAt: Number(r.created_at) });
    }
    return { currency: b?.currency ?? null, balanceMinor: b?.balance_minor ?? 0, updatedAt: b?.updated_at ?? null, entries };
  }

  private async names(tenantId: string, ids: string[]): Promise<Map<string, string>> {
    if (!ids.length) return new Map();
    const rows = (await this.db('users').where({ tenant_id: tenantId }).whereIn('id', [...new Set(ids)]).select('id', 'display_name', 'username')) as { id: string; display_name: string | null; username: string }[];
    return new Map(rows.map((u) => [u.id, u.display_name || u.username]));
  }

  /** Sets the currency (holders of `settings`); refused once the balance is not zero. */
  async setCurrency(ctx: Ctx, groupId: string, currency: string) {
    const s = this.s();
    const a = await s.groups.require(ctx.p, groupId, 'settings');
    const g = a.group;
    const cur = currency.toUpperCase();
    const b = await this.row(g.id);
    if (b && b.currency === cur) return this.view(g.tenant_id, g.id);
    if (b && b.balance_minor !== 0) throw conflict(`The budget holds ${b.balance_minor} in ${b.currency}; bring it to zero before changing the currency.`);
    const t = Date.now();
    if (b) await this.db('group_budgets').where({ group_id: g.id }).update({ currency: cur, updated_at: t });
    else await this.db('group_budgets').insert({ group_id: g.id, tenant_id: g.tenant_id, currency: cur, balance_minor: 0, updated_at: t });
    await s.audit.append({ tenantId: g.tenant_id, action: 'group.budget.currency', kind: 'admin', actor: actorFrom(ctx.p, ctx.ip), target: { group: g.id }, detail: { before: b?.currency ?? null, after: cur }, label: g.label, traceId: ctx.traceId ?? null });
    return this.view(g.tenant_id, g.id);
  }

  /**
   * Records money in (positive) or out (negative) as one ledger entry. The balance never goes below zero; with a
   * `proposalId` the entry is that decision's, made at most once (409 on a second).
   */
  async record(ctx: Ctx, groupId: string, input: { amountMinor: number; memo?: string | null | undefined; proposalId?: string | null | undefined }) {
    const s = this.s();
    const a = await s.groups.require(ctx.p, groupId, 'settings');
    const g = a.group;
    const amount = Math.trunc(input.amountMinor);
    if (!amount || Math.abs(amount) > BUDGET_LIMITS.amountMinor) throw new HttpProblem(422, 'Not an amount', 'Give a whole, non-zero amount in minor units (cents).', { extensions: { step: 'amount' } });
    const id = ulid();
    const memo = input.memo?.trim() ? await s.keys.seal(g.tenant_id, input.memo.trim().slice(0, BUDGET_LIMITS.memo), `group-budget-entry:${id}`) : null;
    const t = Date.now();
    let after = 0;
    let currency = '';
    try {
      await this.db.transaction(async (trx) => {
        const q = trx('group_budgets').where({ group_id: g.id });
        const sqlite = /sqlite/.test(String(trx.client.config.client));
        const b = (await (sqlite ? q : q.forUpdate()).first()) as Record<string, unknown> | undefined;
        if (!b) throw new HttpProblem(409, 'No budget', 'The group has no budget yet: an owner sets its currency first.', { extensions: { step: 'budget' } });
        const balance = Number(b.balance_minor);
        after = balance + amount;
        currency = String(b.currency);
        if (after < 0) throw new HttpProblem(409, 'Not enough in the budget', `The budget holds ${balance} ${currency} (minor units); ${-amount} cannot be spent from it.`, { extensions: { step: 'balance', balanceMinor: balance } });
        await trx('group_budgets').where({ group_id: g.id }).update({ balance_minor: after, updated_at: t });
        await trx('group_budget_entries').insert({ id, tenant_id: g.tenant_id, group_id: g.id, amount_minor: amount, currency, balance_after: after, memo, proposal_id: input.proposalId ?? null, created_by: ctx.p.userId, created_at: t });
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('This decision was already recorded in the budget.');
      throw err;
    }
    await s.audit.append({ tenantId: g.tenant_id, action: amount > 0 ? 'group.budget.credited' : 'group.budget.spent', kind: 'admin', actor: actorFrom(ctx.p, ctx.ip), target: { group: g.id, entry: id, ...(input.proposalId ? { proposal: input.proposalId } : {}) }, detail: { amountMinor: amount, currency, balanceAfter: after, memo: !!memo }, label: g.label, traceId: ctx.traceId ?? null });
    return { id, amountMinor: amount, currency, balanceAfter: after };
  }
}
