import { Router, type Request } from 'express';
import { z } from 'zod';
import { actorFrom } from '../../audit/chain.js';
import { clears } from '../../authz/labels.js';
import { effectivePermissions } from '../../authz/policy.js';
import { ip, noStore, parseBody, principalOf, requireAnyPermission, requireAuth, requirePermission, requireRecentAuth } from '../../http/middleware.js';
import { forbidden, notFound } from '../../http/problem.js';
import { FLAG_STATES, FLAG_TYPES, flagKey, optionsSchema, ROLLOUT_BY, type FlagDef, type LevelValue } from '../../flags/model.js';
import type { FlagActor, ProposalRow } from '../../flags/service.js';
import type { Services } from '../../services.js';

const id26 = z.string().length(26);
const flagValue = z.union([z.boolean(), z.number().finite(), z.string().max(40)]);
const rollout = z.number().int().min(0).max(100).nullable().default(null);
const note = z.string().trim().max(500).nullable().optional();
const isoDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'a date (YYYY-MM-DD)')
  .transform((v) => Date.parse(`${v}T00:00:00Z`));
const planKey = z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/, 'a plan key');
const valueBody = z.object({ value: flagValue, rollout, note }).strict();

const flagView = (f: FlagDef) => ({
  key: f.key,
  type: f.type,
  defaultValue: f.defaultValue,
  options: f.options,
  description: f.description,
  owner: f.owner,
  state: f.state,
  stateChangedAt: f.stateChangedAt,
  reviewAt: f.reviewAt,
  client: f.client,
  overridable: f.overridable,
  rolloutBy: f.rolloutBy,
  createdAt: f.createdAt,
  updatedAt: f.updatedAt
});
const valueView = (v: LevelValue) => ({ id: v.id, scope: v.scope, scopeId: v.scopeId, value: v.value, rollout: v.rollout, note: v.note, updatedAt: v.updatedAt, updatedBy: v.updatedBy });
const proposalView = (p: ProposalRow, viewer: string) => ({ id: p.id, flag: p.flagKey, change: p.change, reason: p.reason, state: p.state, proposedAt: p.proposedAt, proposedBy: p.proposedBy, decidedAt: p.decidedAt, decidedBy: p.decidedBy, note: p.note, mine: p.proposedBy === viewer });

/**
 * 1.9.0, Sprint 52 (B-167 to B-169): Platform › Feature flags and a tenant's overrides.
 *
 * - `GET /admin/feature-flags` and `GET /admin/feature-flags/{key}` (`platform:manage` or `tenant:manage`, clearance
 *   internal): the flags with their stale warnings. Platform admins see every level's values and the pending changes;
 *   tenant admins see their own tenant's and workspaces' values. Without migration 137 the list answers
 *   `available: false`.
 * - Definitions, life cycle, plan values (`platform:manage`): create, describe, move along the life cycle (a recent
 *   sign-in), set or clear a plan's value.
 * - `PUT /admin/feature-flags/{key}/platform` (`platform:manage`, a recent sign-in): the default and the platform value
 *   with its rollout. A live flag's change waits (202) for a second platform admin to approve it (dual control).
 * - `PUT|DELETE /admin/feature-flags/{key}/tenant` and `…/workspaces/{id}` (`tenant:manage`): the caller's own
 *   tenant's values (the tenant is the session's, never the body's).
 * - `GET /admin/feature-flags/{key}/explain` (`platform:manage` or `tenant:manage`): "why does this tenant see this",
 *   the winning level and the account of every level, for the caller's tenant (platform admins may name another with
 *   `?tenant=`), a workspace and a person.
 * - `GET /me/flags`: the flags the console reads, for the signed-in person.
 */
export function featureFlagRoutes(s: Services): Router {
  const r = Router();
  const read = requireAnyPermission(s, ['platform:manage', 'tenant:manage']);
  const platform = requirePermission(s, 'platform:manage');
  const tenant = requirePermission(s, 'tenant:manage');
  const recent = [requireAuth({ sessionOnly: true }), requireRecentAuth(s)];
  r.use('/admin/feature-flags', noStore, requireAuth());

  const isPlatform = (req: Request) => effectivePermissions(principalOf(req)).has('platform:manage');
  const actorOf = (req: Request): FlagActor => {
    const p = principalOf(req);
    return { tenantId: p.tenantId, userId: p.userId, actor: actorFrom(p, ip(req)), ...(req.traceId ? { traceId: req.traceId } : {}) };
  };
  /** Flags are labelled internal: a reader needs that clearance. */
  const cleared = (req: Request) => {
    if (!clears(principalOf(req).clearance, 'internal')) throw forbidden('Feature flags are internal; your clearance does not reach them.', { step: 'clearance' });
  };
  const keyOf = (req: Request) => parseBody(flagKey, req.params.key);

  // ---------- the list and one flag ----------

  r.get('/admin/feature-flags', read, async (req, res) => {
    cleared(req);
    const all = isPlatform(req);
    if (!(await s.flags.available())) return void res.json({ available: false, flags: [], canManage: all, pending: [] });
    const p = principalOf(req);
    const rows = await s.flags.list({ tenantId: p.tenantId });
    const flags = rows
      .filter((x) => all || x.flag.state !== 'removed')
      .map((x) => ({
        ...flagView(x.flag),
        stale: x.stale,
        mine: { tenant: x.mine?.tenant ? valueView(x.mine.tenant) : null, workspaces: (x.mine?.workspaces ?? []).map(valueView) },
        ...(all ? { platform: x.platform ? valueView(x.platform) : null, counts: x.counts, pending: x.pending ? proposalView(x.pending, p.userId) : null } : {})
      }));
    const pending = all ? (await s.flags.proposals({ state: 'pending' })).map((x) => proposalView(x, p.userId)) : [];
    res.json({ available: true, flags, canManage: all, pending, workspaces: (await s.tenants.workspaces(p.tenantId)).map((w) => ({ id: w.id, name: w.name })) });
  });

  r.post('/admin/feature-flags', platform, ...recent, async (req, res) => {
    const body = parseBody(
      z
        .object({
          key: flagKey,
          type: z.enum(FLAG_TYPES),
          defaultValue: flagValue,
          options: optionsSchema.optional(),
          description: z.string().trim().max(1000).default(''),
          owner: z.string().trim().max(200).default(''),
          state: z.enum(['planned', 'active']).default('planned'),
          reviewAt: isoDay.nullable().optional(),
          client: z.boolean().default(true),
          overridable: z.boolean().default(true),
          rolloutBy: z.enum(ROLLOUT_BY).default('user')
        })
        .strict(),
      req.body
    );
    const f = await s.flags.create(actorOf(req), body);
    res.status(201).json(flagView(f));
  });

  r.get('/admin/feature-flags/proposals', platform, async (req, res) => {
    cleared(req);
    const q = parseBody(z.object({ state: z.enum(['pending', 'approved', 'rejected', 'withdrawn', 'superseded']).optional(), key: flagKey.optional() }).strict(), req.query);
    res.json({ proposals: (await s.flags.proposals(q)).map((p) => proposalView(p, principalOf(req).userId)) });
  });

  r.post('/admin/feature-flags/proposals/:id/approve', platform, ...recent, async (req, res) => {
    const body = parseBody(z.object({ note }).strict(), req.body ?? {});
    const { flag, proposal } = await s.flags.approve(actorOf(req), parseBody(id26, req.params.id), body.note ?? null);
    res.json({ flag: flagView(flag), proposal: proposalView(proposal, principalOf(req).userId) });
  });

  r.post('/admin/feature-flags/proposals/:id/reject', platform, async (req, res) => {
    const body = parseBody(z.object({ note }).strict(), req.body ?? {});
    const p = await s.flags.reject(actorOf(req), parseBody(id26, req.params.id), body.note ?? null);
    res.json(proposalView(p, principalOf(req).userId));
  });

  r.get('/admin/feature-flags/:key', read, async (req, res) => {
    cleared(req);
    const all = isPlatform(req);
    const p = principalOf(req);
    const f = await s.flags.get(keyOf(req));
    if (!all && f.state === 'removed') throw notFound('Feature flag');
    const values = await s.flags.values(f.key, all ? {} : { tenantId: p.tenantId });
    const ctx = { tenantId: p.tenantId, workspaceId: p.workspaceId ?? null, userId: p.userId };
    res.json({
      flag: flagView(f),
      stale: (await s.flags.list()).find((x) => x.flag.key === f.key)?.stale ?? [],
      values: values.map(valueView),
      ...(all ? { proposals: (await s.flags.proposals({ key: f.key, limit: 20 })).map((x) => proposalView(x, p.userId)) } : {}),
      you: await s.flags.evaluate(ctx, f.key),
      canManage: all
    });
  });

  r.patch('/admin/feature-flags/:key', platform, async (req, res) => {
    const body = parseBody(
      z
        .object({ description: z.string().trim().max(1000).optional(), owner: z.string().trim().max(200).optional(), reviewAt: isoDay.nullable().optional(), client: z.boolean().optional(), overridable: z.boolean().optional(), rolloutBy: z.enum(ROLLOUT_BY).optional(), options: optionsSchema.optional() })
        .strict(),
      req.body
    );
    res.json(flagView(await s.flags.update(actorOf(req), keyOf(req), body)));
  });

  r.post('/admin/feature-flags/:key/state', platform, ...recent, async (req, res) => {
    const body = parseBody(z.object({ state: z.enum(FLAG_STATES), note }).strict(), req.body);
    res.json(flagView(await s.flags.setState(actorOf(req), keyOf(req), body.state, body.note ?? null)));
  });

  // ---------- the platform level: dual control for live flags ----------

  r.put('/admin/feature-flags/:key/platform', platform, ...recent, async (req, res) => {
    const body = parseBody(z.object({ defaultValue: flagValue.optional(), platform: z.object({ value: flagValue, rollout }).strict().nullable().optional(), reason: z.string().trim().max(500).nullable().optional() }).strict(), req.body);
    const { reason, ...change } = body;
    const out = await s.flags.changePlatform(actorOf(req), keyOf(req), change, reason ?? null);
    res.status(out.applied ? 200 : 202).json({ applied: out.applied, flag: flagView(out.flag), proposal: out.proposal ? proposalView(out.proposal, principalOf(req).userId) : null });
  });

  // ---------- plan, tenant and workspace values ----------

  r.put('/admin/feature-flags/:key/plans/:plan', platform, async (req, res) => {
    const body = parseBody(valueBody, req.body);
    res.json(valueView(await s.flags.setValue(actorOf(req), keyOf(req), 'plan', parseBody(planKey, req.params.plan), body)));
  });
  r.delete('/admin/feature-flags/:key/plans/:plan', platform, async (req, res) => {
    await s.flags.clearValue(actorOf(req), keyOf(req), 'plan', parseBody(planKey, req.params.plan));
    res.status(204).end();
  });

  r.put('/admin/feature-flags/:key/tenant', tenant, async (req, res) => {
    cleared(req);
    const body = parseBody(valueBody, req.body);
    res.json(valueView(await s.flags.setValue(actorOf(req), keyOf(req), 'tenant', null, body)));
  });
  r.delete('/admin/feature-flags/:key/tenant', tenant, async (req, res) => {
    cleared(req);
    await s.flags.clearValue(actorOf(req), keyOf(req), 'tenant', null);
    res.status(204).end();
  });

  r.put('/admin/feature-flags/:key/workspaces/:workspace', tenant, async (req, res) => {
    cleared(req);
    const body = parseBody(valueBody, req.body);
    res.json(valueView(await s.flags.setValue(actorOf(req), keyOf(req), 'workspace', parseBody(id26, req.params.workspace), body)));
  });
  r.delete('/admin/feature-flags/:key/workspaces/:workspace', tenant, async (req, res) => {
    cleared(req);
    await s.flags.clearValue(actorOf(req), keyOf(req), 'workspace', parseBody(id26, req.params.workspace));
    res.status(204).end();
  });

  // ---------- why does this tenant see this ----------

  r.get('/admin/feature-flags/:key/explain', read, async (req, res) => {
    cleared(req);
    const p = principalOf(req);
    const q = parseBody(z.object({ tenant: id26.optional(), workspace: id26.optional(), user: id26.optional() }).strict(), req.query);
    let tenantId = p.tenantId;
    if (q.tenant && q.tenant !== p.tenantId) {
      if (!isPlatform(req)) throw forbidden('Other tenants are for platform admins.', { step: 'tenant' });
      if (!(await s.tenants.byId(q.tenant))) throw notFound('Tenant');
      tenantId = q.tenant;
    }
    if (q.workspace && !(await s.tenants.workspace(tenantId, q.workspace))) throw notFound('Workspace');
    if (q.user && !(await s.users.get(tenantId, q.user))) throw notFound('User');
    const key = keyOf(req);
    res.json(await s.flags.evaluate({ tenantId, workspaceId: q.workspace ?? null, userId: q.user ?? null }, key));
  });

  // ---------- the console's own flags ----------

  r.get('/me/flags', noStore, requireAuth(), async (req, res) => {
    const p = principalOf(req);
    res.json({ flags: await s.flags.forClient({ tenantId: p.tenantId, workspaceId: p.workspaceId ?? null, userId: p.userId }) });
  });

  return r;
}
