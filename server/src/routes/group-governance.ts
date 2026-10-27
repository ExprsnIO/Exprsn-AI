import { Router, type Request } from 'express';
import { z } from 'zod';
import { BUDGET_LIMITS } from '../groups/budget.js';
import { GOVERNANCE_LIMITS, PROPOSAL_KINDS, PROPOSAL_STATES, PROPOSE_MODES } from '../groups/governance.js';
import { METHODS, QUORUM_KINDS } from '../groups/tally.js';
import type { Ctx } from '../groups/service.js';
import { HttpProblem } from '../http/problem.js';
import { ip, noStore, parseBody, principalOf, requireAuth, requirePermission } from '../http/middleware.js';
import type { Services } from '../services.js';

/*
 * 1.9.0, Sprint 53 (B-174 to B-176): group governance. `groups:read` to read proposals, results and the budget,
 * `groups:write` to propose, vote, confirm and change settings; inside the group, what the caller may do is decided by
 * their rights there and the group's governance settings (groups/governance.ts). The tenant is the session's.
 */

const id26 = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'an id');
const threshold = z.object({ num: z.number().int().min(1).max(GOVERNANCE_LIMITS.fractionDen), den: z.number().int().min(2).max(GOVERNANCE_LIMITS.fractionDen) }).strict();
const quorum = z.object({ kind: z.enum(QUORUM_KINDS), value: z.number().int().min(0).max(1_000_000) }).strict();
const hours = z.number().int().min(GOVERNANCE_LIMITS.minHours).max(GOVERNANCE_LIMITS.maxHours);
const choice = z.union([z.enum(['yes', 'no', 'abstain']), z.array(z.string().regex(/^o\d{1,2}$/)).max(GOVERNANCE_LIMITS.options)]);
const proposalFields = {
  title: z.string().trim().min(1).max(GOVERNANCE_LIMITS.title),
  body: z.string().max(GOVERNANCE_LIMITS.body).optional(),
  options: z.array(z.string().trim().min(1).max(GOVERNANCE_LIMITS.optionLabel)).max(GOVERNANCE_LIMITS.options).optional(),
  action: z.record(z.string(), z.unknown()).optional(),
  method: z.enum(METHODS).optional(),
  threshold: threshold.optional(),
  quorum: quorum.optional(),
  secret: z.boolean().optional(),
  hours: hours.optional()
};

export function groupGovernanceRoutes(s: Services): Router {
  const r = Router();
  r.use(['/groups/:id/governance', '/groups/:id/proposals', '/groups/:id/budget', '/group-proposals'], noStore, requireAuth());
  const read = requirePermission(s, 'groups:read');
  const write = requirePermission(s, 'groups:write');
  const gov = s.groupGovernance;
  const ctx = (req: Request): Ctx => ({ p: principalOf(req), ip: ip(req), traceId: req.traceId ?? null });
  const idOf = (req: Request) => parseBody(id26, (req.params as Record<string, string>).id);

  // ---------- settings ----------

  r.get('/groups/:id/governance', read, async (req, res) => {
    res.json(await gov.view(principalOf(req), idOf(req)));
  });

  r.put('/groups/:id/governance', write, async (req, res) => {
    const body = parseBody(z.object({
      propose: z.enum(PROPOSE_MODES).optional(),
      proposeRole: z.string().trim().min(1).max(26).nullable().optional(),
      method: z.enum(METHODS).optional(),
      threshold: threshold.optional(),
      quorum: quorum.optional(),
      minHours: hours.optional(),
      maxHours: hours.optional(),
      defaultHours: hours.optional(),
      secret: z.boolean().optional(),
      confirmKinds: z.array(z.enum(['setting', 'member', 'role', 'rules', 'spend'])).max(5).optional(),
      rules: z.string().max(GOVERNANCE_LIMITS.rules).nullable().optional()
    }).strict(), req.body);
    res.json(await gov.updateSettings(ctx(req), idOf(req), body as Parameters<typeof gov.updateSettings>[2]));
  });

  // ---------- proposals ----------

  r.get('/groups/:id/proposals', read, async (req, res) => {
    const q = parseBody(z.object({ state: z.enum(PROPOSAL_STATES).optional() }), req.query);
    res.json(await gov.list(principalOf(req), idOf(req), q));
  });

  r.post('/groups/:id/proposals', write, async (req, res) => {
    const body = parseBody(z.object({ kind: z.enum(PROPOSAL_KINDS), ...proposalFields }).strict(), req.body);
    res.status(201).json(await gov.create(ctx(req), idOf(req), body));
  });

  r.get('/group-proposals/:id', read, async (req, res) => {
    res.json(await gov.get(principalOf(req), idOf(req)));
  });

  r.patch('/group-proposals/:id', write, async (req, res) => {
    const body = parseBody(z.object({ kind: z.enum(PROPOSAL_KINDS).optional(), ...proposalFields, title: proposalFields.title.optional() }).strict(), req.body);
    res.json(await gov.update(ctx(req), idOf(req), body));
  });

  r.delete('/group-proposals/:id', write, async (req, res) => {
    res.json(await gov.remove(ctx(req), idOf(req)));
  });

  r.post('/group-proposals/:id/open', write, async (req, res) => {
    const body = parseBody(z.object({ hours: hours.optional() }).strict(), req.body ?? {});
    res.json(await gov.open(ctx(req), idOf(req), body));
  });

  // The ballot id and change token of a secret ballot travel in the body, never in the URL (which is logged).
  r.post('/group-proposals/:id/ballots', write, async (req, res) => {
    const body = parseBody(z.object({ choice, ballotId: z.string().regex(/^[0-9a-f]{32}$/).optional(), token: z.string().min(16).max(100).optional() }).strict(), req.body);
    res.json(await gov.vote(ctx(req), idOf(req), body));
  });

  r.post('/group-proposals/:id/verify-receipt', read, async (req, res) => {
    const body = parseBody(z.object({ commitment: z.string().regex(/^[0-9a-f]{64}$/), choice }).strict(), req.body);
    res.json(await gov.verifyReceipt(principalOf(req), idOf(req), body));
  });

  r.post('/group-proposals/:id/confirm', write, async (req, res) => {
    res.json(await gov.confirm(ctx(req), idOf(req)));
  });

  r.post('/group-proposals/:id/decline', write, async (req, res) => {
    const body = parseBody(z.object({ reason: z.string().trim().max(500).nullable().optional() }).strict(), req.body ?? {});
    res.json(await gov.decline(ctx(req), idOf(req), body.reason ?? null));
  });

  // ---------- the budget ----------

  r.get('/groups/:id/budget', read, async (req, res) => {
    const id = idOf(req);
    const p = principalOf(req);
    const a = await s.groups.require(p, id, 'read');
    if (!(await gov.installed())) {
      res.json({ available: false, currency: null, balanceMinor: 0, entries: [] });
      return;
    }
    res.json({ available: true, canManage: a.rights.has('settings'), ...(await gov.budget.view(a.group.tenant_id, a.group.id)) });
  });

  r.put('/groups/:id/budget', write, async (req, res) => {
    const body = parseBody(z.object({ currency: z.string().regex(/^[A-Za-z]{3}$/, 'a three-letter currency code') }).strict(), req.body);
    if (!(await gov.installed())) throw notInstalledProblem();
    res.json(await gov.budget.setCurrency(ctx(req), idOf(req), body.currency));
  });

  r.post('/groups/:id/budget/entries', write, async (req, res) => {
    const body = parseBody(z.object({ amountMinor: z.number().int().min(-BUDGET_LIMITS.amountMinor).max(BUDGET_LIMITS.amountMinor), memo: z.string().trim().max(BUDGET_LIMITS.memo).nullable().optional() }).strict(), req.body);
    if (!(await gov.installed())) throw notInstalledProblem();
    res.status(201).json(await gov.budget.record(ctx(req), idOf(req), body));
  });

  return r;
}

const notInstalledProblem = () => new HttpProblem(503, 'Not installed', 'Group budgets need the database migration 134_group_votes, which has not been applied.', { extensions: { reason: 'migration_pending' } });
